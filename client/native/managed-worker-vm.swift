import CoreFoundation
import CryptoKit
import Darwin
import Foundation
import Virtualization

private let artifactPort: UInt32 = 10_790
private let controlPort: UInt32 = 10_789
private let guestCPUmax = "100000 100000"
private let guestPIDsMax = 16
private let maxFrameBytes = 1_024 * 1_024
private let maxHeaderBytes = 4_096
private let stoppedFrame = "{\"type\":\"stopped\"}\n"

private enum LauncherError: Error, CustomStringConvertible {
  case message(String)

  var description: String {
    switch self {
    case .message(let value): value
    }
  }
}

private struct Arguments {
  let entrypoint: String
  let kernel: URL
  let initramfs: URL
  let rootfs: URL
  let package: URL
  let input: URL
  let scratch: URL
  let memoryBytes: UInt64
  let outputBytes: UInt64
  let outputRoot: URL
  let scratchBytes: UInt64
  let wallTimeMilliseconds: UInt64
  let workerMemoryBytes: UInt64

  init(_ values: [String]) throws {
    guard values.count == 26 else { throw LauncherError.message("invalid arguments") }
    var options: [String: String] = [:]
    for index in stride(from: 0, to: values.count, by: 2) {
      guard values[index].hasPrefix("--"), options[values[index]] == nil else {
        throw LauncherError.message("invalid arguments")
      }
      options[values[index]] = values[index + 1]
    }
    let expected = Set([
      "--entrypoint", "--kernel", "--initramfs", "--rootfs", "--package", "--input", "--scratch",
      "--memory-bytes", "--output-bytes", "--output-root", "--scratch-bytes", "--wall-time-ms",
      "--worker-memory-bytes",
    ])
    guard Set(options.keys) == expected else {
      throw LauncherError.message("invalid arguments")
    }
    entrypoint = try Self.packagePath(options["--entrypoint"]!)
    kernel = try Self.regularFile(options["--kernel"]!)
    initramfs = try Self.regularFile(options["--initramfs"]!)
    rootfs = try Self.regularFile(options["--rootfs"]!)
    package = try Self.regularFile(options["--package"]!)
    input = try Self.regularFile(options["--input"]!)
    scratch = try Self.regularFile(options["--scratch"]!)
    outputRoot = try Self.regularDirectory(options["--output-root"]!)
    try Self.requireSize(kernel, 1...256 << 20)
    try Self.requireSize(initramfs, 1...512 << 20)
    try Self.requireSize(rootfs, 16 << 20...8 << 30, aligned: true)
    try Self.requireSize(package, 16 << 20...8 << 30, aligned: true)
    try Self.requireSize(input, 16 << 20...8 << 30, aligned: true)
    memoryBytes = try Self.integer(options["--memory-bytes"]!, 256 << 20...16 << 30)
    outputBytes = try Self.integer(options["--output-bytes"]!, 1 << 20...8 << 30)
    scratchBytes = try Self.integer(options["--scratch-bytes"]!, 16 << 20...8 << 30)
    wallTimeMilliseconds = try Self.integer(options["--wall-time-ms"]!, 100...3_600_000)
    workerMemoryBytes = try Self.integer(
      options["--worker-memory-bytes"]!, 16 << 20...8 << 30)
    guard
      memoryBytes.isMultiple(of: 4_096), scratchBytes.isMultiple(of: 4_096),
      workerMemoryBytes.isMultiple(of: 4_096)
    else {
      throw LauncherError.message("unaligned resource limit")
    }
    guard workerMemoryBytes < memoryBytes else {
      throw LauncherError.message("worker memory must be smaller than VM memory")
    }
    guard outputBytes <= scratchBytes else {
      throw LauncherError.message("output limit exceeds scratch capacity")
    }
    let scratchSize = try scratch.resourceValues(forKeys: [.fileSizeKey]).fileSize
    guard scratchSize == Int(scratchBytes) else {
      throw LauncherError.message("scratch image size changed")
    }
  }

  private static func regularFile(_ value: String) throws -> URL {
    guard value.hasPrefix("/") else { throw LauncherError.message("path is not absolute") }
    let url = URL(fileURLWithPath: value).standardizedFileURL
    guard url.path == url.resolvingSymlinksInPath().path else {
      throw LauncherError.message("path contains a symlink")
    }
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
      throw LauncherError.message("required image is unavailable")
    }
    return url
  }

  private static func regularDirectory(_ value: String) throws -> URL {
    guard value.hasPrefix("/") else { throw LauncherError.message("path is not absolute") }
    let url = URL(fileURLWithPath: value, isDirectory: true).standardizedFileURL
    guard url.path == url.resolvingSymlinksInPath().path else {
      throw LauncherError.message("path contains a symlink")
    }
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else {
      throw LauncherError.message("output root is unavailable")
    }
    return url
  }

  private static func packagePath(_ value: String) throws -> String {
    let parts = value.split(separator: "/", omittingEmptySubsequences: false)
    guard
      !value.isEmpty, value.utf8.count <= 512, !value.hasPrefix("/"), !value.contains("\\"),
      !value.contains("\0"), !value.contains("//"),
      parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
    else { throw LauncherError.message("entrypoint path is invalid") }
    return value
  }

  private static func requireSize(
    _ url: URL, _ range: ClosedRange<UInt64>, aligned: Bool = false
  ) throws {
    guard let rawSize = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
      rawSize >= 0
    else { throw LauncherError.message("image size is unavailable") }
    let size = UInt64(rawSize)
    guard range.contains(size), !aligned || size.isMultiple(of: 4_096) else {
      throw LauncherError.message("image size is invalid")
    }
  }

  private static func integer(
    _ value: String, _ range: ClosedRange<UInt64>
  ) throws -> UInt64 {
    guard let parsed = UInt64(value), range.contains(parsed) else {
      throw LauncherError.message("resource limit is invalid")
    }
    return parsed
  }
}

private final class Runner: NSObject, VZVirtualMachineDelegate {
  private let arguments: Arguments
  private let configureFrame: String
  private let expectedConfiguredFrame: String
  private let expectedReadyFrame: String
  private let publicReadyFrame: String
  private var artifactConnection: VZVirtioSocketConnection?
  private let lock = NSLock()
  private var connection: VZVirtioSocketConnection?
  private var failureStarted = false
  private var finished = false
  private var ready = false
  private var stopped = false
  private var signalSources: [DispatchSourceSignal] = []
  private var virtualMachine: VZVirtualMachine!

  init(arguments: Arguments) throws {
    self.arguments = arguments
    expectedReadyFrame =
      "{\"input_read_only\":true,\"package_read_only\":true,\"protocol_version\":1,"
      + "\"rootfs_read_only\":true,\"scratch_bytes\":\(arguments.scratchBytes),"
      + "\"type\":\"ready\"}\n"
    configureFrame = try jsonFrame([
      "entrypoint": arguments.entrypoint,
      "memory_bytes": arguments.workerMemoryBytes,
      "output_bytes": arguments.outputBytes,
      "type": "configure",
    ])
    expectedConfiguredFrame =
      "{\"cpu_max\":\"\(guestCPUmax)\",\"memory_bytes\":\(arguments.workerMemoryBytes),"
      + "\"output_bytes\":\(arguments.outputBytes),\"pids_max\":\(guestPIDsMax),"
      + "\"type\":\"configured\"}\n"
    publicReadyFrame =
      "{\"cpu_max\":\"\(guestCPUmax)\",\"input_read_only\":true,\"memory_bytes\":"
      + "\(arguments.workerMemoryBytes),\"output_bytes\":\(arguments.outputBytes),"
      + "\"pids_max\":\(guestPIDsMax),\"protocol_version\":1,\"package_read_only\":true,"
      + "\"rootfs_read_only\":true,\"scratch_bytes\":\(arguments.scratchBytes),"
      + "\"type\":\"ready\"}\n"
    super.init()
    virtualMachine = try Self.makeVirtualMachine(arguments)
    virtualMachine.delegate = self
  }

  func run() {
    installSignalHandlers()
    DispatchQueue.main.asyncAfter(
      deadline: .now() + .milliseconds(Int(arguments.wallTimeMilliseconds))
    ) { [weak self] in
      self?.failOnMain("wall-time limit exceeded")
    }
    virtualMachine.start { [weak self] result in
      guard let self else { return }
      switch result {
      case .success:
        guard
          let socket = self.virtualMachine.socketDevices.first
            as? VZVirtioSocketDevice
        else { return self.fail("Virtio socket is unavailable") }
        self.connect(socket, attempts: 20)
      case .failure(let error):
        self.fail("VM start failed: \(error.localizedDescription)")
      }
    }
    RunLoop.main.run()
  }

  func guestDidStop(_ virtualMachine: VZVirtualMachine) {
    lock.lock()
    let succeeded = ready && stopped && !failureStarted
    lock.unlock()
    finish(succeeded ? EXIT_SUCCESS : EXIT_FAILURE)
  }

  private static func makeVirtualMachine(_ arguments: Arguments) throws -> VZVirtualMachine {
    let bootLoader = VZLinuxBootLoader(kernelURL: arguments.kernel)
    bootLoader.initialRamdiskURL = arguments.initramfs
    bootLoader.commandLine = "console=hvc0 quiet loglevel=3 rdinit=/init panic=-1"
    let inputAttachment = try VZDiskImageStorageDeviceAttachment(
      url: arguments.input, readOnly: true
    )
    let packageAttachment = try VZDiskImageStorageDeviceAttachment(
      url: arguments.package, readOnly: true
    )
    let scratchAttachment = try VZDiskImageStorageDeviceAttachment(
      url: arguments.scratch, readOnly: false
    )
    let rootfsAttachment = try VZDiskImageStorageDeviceAttachment(
      url: arguments.rootfs, readOnly: true
    )
    let configuration = VZVirtualMachineConfiguration()
    configuration.bootLoader = bootLoader
    configuration.cpuCount = 1
    configuration.memorySize = arguments.memoryBytes
    let console = VZVirtioConsoleDeviceSerialPortConfiguration()
    console.attachment = VZFileHandleSerialPortAttachment(
      fileHandleForReading: nil,
      fileHandleForWriting: FileHandle.standardError
    )
    configuration.serialPorts = [console]
    configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]
    configuration.storageDevices = [
      VZVirtioBlockDeviceConfiguration(attachment: packageAttachment),
      VZVirtioBlockDeviceConfiguration(attachment: inputAttachment),
      VZVirtioBlockDeviceConfiguration(attachment: scratchAttachment),
      VZVirtioBlockDeviceConfiguration(attachment: rootfsAttachment),
    ]
    try configuration.validate()
    return VZVirtualMachine(configuration: configuration)
  }

  private func connect(_ socket: VZVirtioSocketDevice, attempts: Int) {
    socket.connect(toPort: controlPort) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let connection):
        self.connection = connection
        DispatchQueue.main.async {
          self.connectArtifacts(socket, control: connection, attempts: 20)
        }
      case .failure where attempts > 1:
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
          self.connect(socket, attempts: attempts - 1)
        }
      case .failure(let error):
        self.fail("Guest connection failed: \(error.localizedDescription)")
      }
    }
  }

  private func connectArtifacts(
    _ socket: VZVirtioSocketDevice,
    control: VZVirtioSocketConnection,
    attempts: Int
  ) {
    socket.connect(toPort: artifactPort) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let artifacts):
        self.artifactConnection = artifacts
        DispatchQueue.global(qos: .userInitiated).async {
          self.relay(control, artifacts: artifacts)
        }
      case .failure where attempts > 1:
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
          self.connectArtifacts(socket, control: control, attempts: attempts - 1)
        }
      case .failure(let error):
        self.fail("Guest artifact connection failed: \(error.localizedDescription)")
      }
    }
  }

  private func relay(
    _ connection: VZVirtioSocketConnection,
    artifacts: VZVirtioSocketConnection
  ) {
    let descriptor = connection.fileDescriptor
    do {
      guard try readFrame(descriptor) == expectedReadyFrame else {
        throw LauncherError.message("Guest attestation changed")
      }
      try writeFrame(configureFrame, descriptor)
      guard try readFrame(descriptor) == expectedConfiguredFrame else {
        throw LauncherError.message("Guest resource policy changed")
      }
      try writeFrame(publicReadyFrame, FileHandle.standardOutput.fileDescriptor)
      lock.lock()
      ready = true
      lock.unlock()
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        do {
          while true {
            try writeFrame(try readFrame(FileHandle.standardInput.fileDescriptor), descriptor)
          }
        } catch {
          if case LauncherError.message(let message) = error, message == "protocol closed" {
            return
          }
          self?.fail("Host protocol failed")
        }
      }
      while true {
        let frame = try readFrame(descriptor)
        if let count = try artifactSignalCount(frame) {
          try receiveArtifacts(
            artifacts.fileDescriptor,
            count: count,
            outputRoot: arguments.outputRoot,
            outputLimit: arguments.outputBytes
          )
          continue
        }
        try writeFrame(frame, FileHandle.standardOutput.fileDescriptor)
        if frame == stoppedFrame {
          lock.lock()
          stopped = true
          lock.unlock()
        }
      }
    } catch {
      lock.lock()
      let cleanStop = stopped
      lock.unlock()
      if !cleanStop { fail(String(describing: error)) }
    }
  }

  private func installSignalHandlers() {
    for number in [SIGINT, SIGTERM] {
      signal(number, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
      source.setEventHandler { [weak self] in self?.failOnMain("Host cancelled VM") }
      source.resume()
      signalSources.append(source)
    }
  }

  private func fail(_ message: String) {
    DispatchQueue.main.async { [weak self] in self?.failOnMain(message) }
  }

  private func failOnMain(_ message: String) {
    lock.lock()
    let shouldFail = !finished && !failureStarted
    if shouldFail { failureStarted = true }
    lock.unlock()
    guard shouldFail else { return }
    FileHandle.standardError.write(Data("shejane-managed-worker-vm: \(message)\n".utf8))
    if virtualMachine.state == .running, virtualMachine.canStop {
      virtualMachine.stop { [weak self] _ in self?.finish(EXIT_FAILURE) }
    } else {
      finish(EXIT_FAILURE)
    }
  }

  private func finish(_ status: Int32) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    lock.unlock()
    connection?.close()
    artifactConnection?.close()
    exit(status)
  }
}

private func readFrame(_ descriptor: Int32, limit: Int = maxFrameBytes) throws -> String {
  var bytes: [UInt8] = []
  while bytes.count < limit {
    var byte: UInt8 = 0
    let count = Darwin.read(descriptor, &byte, 1)
    if count == 0 { throw LauncherError.message("protocol closed") }
    if count < 0 {
      if errno == EINTR { continue }
      throw LauncherError.message("protocol read failed")
    }
    bytes.append(byte)
    if byte == 0x0A {
      guard let frame = String(bytes: bytes, encoding: .utf8) else {
        throw LauncherError.message("protocol frame is not UTF-8")
      }
      return frame
    }
  }
  throw LauncherError.message("protocol frame limit exceeded")
}

private func writeFrame(_ frame: String, _ descriptor: Int32) throws {
  let bytes = Array(frame.utf8)
  guard !bytes.isEmpty, bytes.count <= maxFrameBytes, bytes.last == 0x0A else {
    throw LauncherError.message("protocol frame is invalid")
  }
  try writeBytes(bytes, descriptor)
}

private func writeBytes(_ bytes: [UInt8], _ descriptor: Int32) throws {
  try bytes.withUnsafeBytes { buffer in
    var written = 0
    while written < buffer.count {
      let count = Darwin.write(
        descriptor, buffer.baseAddress!.advanced(by: written), buffer.count - written
      )
      if count < 0, errno == EINTR { continue }
      if count <= 0 { throw LauncherError.message("protocol write failed") }
      written += count
    }
  }
}

private func artifactSignalCount(_ frame: String) throws -> Int? {
  guard
    let data = frame.data(using: .utf8),
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    object["type"] as? String == "artifacts"
  else { return nil }
  guard
    Set(object.keys) == ["count", "type"],
    let count = exactInteger(object["count"]),
    1...256 ~= count
  else { throw LauncherError.message("Guest artifact signal is invalid") }
  return Int(count)
}

private func receiveArtifacts(
  _ descriptor: Int32,
  count: Int,
  outputRoot: URL,
  outputLimit: UInt64
) throws {
  let rootDescriptor = Darwin.open(
    outputRoot.path,
    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
  )
  guard rootDescriptor >= 0 else {
    throw LauncherError.message("Artifact output root is unavailable")
  }
  defer { close(rootDescriptor) }
  var seen: Set<String> = []
  var total: UInt64 = 0
  for _ in 0..<count {
    let header = try readFrame(descriptor, limit: maxHeaderBytes)
    guard
      let data = header.data(using: .utf8),
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == ["path", "sha256", "size"],
      let path = object["path"] as? String,
      let components = relativePathComponents(path),
      let digest = object["sha256"] as? String,
      digest.utf8.count == 64,
      digest.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
      let size = exactInteger(object["size"]),
      !seen.contains(path),
      size <= outputLimit - total
    else { throw LauncherError.message("Guest artifact header is invalid") }
    seen.insert(path)
    total += size
    let output = try openOutputFile(rootDescriptor, components: components)
    do {
      var hasher = SHA256()
      var remaining = size
      var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
      while remaining > 0 {
        let requested = min(buffer.count, Int(remaining))
        let readCount = buffer.withUnsafeMutableBytes {
          Darwin.read(descriptor, $0.baseAddress, requested)
        }
        guard readCount > 0 else {
          throw LauncherError.message("Guest artifact data closed")
        }
        let chunk = Data(buffer[0..<readCount])
        hasher.update(data: chunk)
        try writeBytes(Array(chunk), output.descriptor)
        remaining -= UInt64(readCount)
      }
      guard fsync(output.descriptor) == 0 else {
        throw LauncherError.message("Artifact sync failed")
      }
      let actual = hasher.finalize().map { String(format: "%02x", $0) }.joined()
      guard actual == digest else {
        throw LauncherError.message("Guest artifact digest changed")
      }
      close(output.descriptor)
      close(output.parentDescriptor)
    } catch {
      close(output.descriptor)
      output.name.withCString { _ = unlinkat(output.parentDescriptor, $0, 0) }
      close(output.parentDescriptor)
      throw error
    }
  }
  guard try readFrame(descriptor, limit: maxHeaderBytes) == "{\"type\":\"end\"}\n" else {
    throw LauncherError.message("Guest artifact stream did not end")
  }
  try writeFrame("{\"type\":\"ack\"}\n", descriptor)
}

private struct OutputFile {
  let descriptor: Int32
  let parentDescriptor: Int32
  let name: String
}

private func openOutputFile(_ rootDescriptor: Int32, components: [String]) throws -> OutputFile {
  var directory = dup(rootDescriptor)
  guard directory >= 0 else { throw LauncherError.message("Artifact root duplication failed") }
  for component in components.dropLast() {
    var next = component.withCString {
      openat(directory, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    }
    if next < 0, errno == ENOENT {
      let created = component.withCString { mkdirat(directory, $0, 0o700) }
      if created == 0 {
        next = component.withCString {
          openat(directory, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
      }
    }
    guard next >= 0 else {
      close(directory)
      throw LauncherError.message("Artifact directory is unsafe")
    }
    close(directory)
    directory = next
  }
  let name = components.last!
  let descriptor = name.withCString {
    openat(
      directory,
      $0,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      0o600
    )
  }
  guard descriptor >= 0 else {
    close(directory)
    throw LauncherError.message("Artifact destination is unsafe")
  }
  return OutputFile(descriptor: descriptor, parentDescriptor: directory, name: name)
}

private func relativePathComponents(_ value: String) -> [String]? {
  guard
    !value.isEmpty, value.utf8.count <= 512, !value.hasPrefix("/"), !value.contains("\\"),
    !value.contains("\0"), !value.contains("//")
  else { return nil }
  let parts = value.split(separator: "/", omittingEmptySubsequences: false)
  guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
  return parts.map(String.init)
}

private func exactInteger(_ value: Any?) -> UInt64? {
  guard
    let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID(),
    number.doubleValue.isFinite,
    number.doubleValue >= 0,
    number.doubleValue.rounded(.towardZero) == number.doubleValue,
    number.doubleValue <= Double(UInt64.max)
  else { return nil }
  return number.uint64Value
}

private func jsonFrame(_ value: [String: Any]) throws -> String {
  let data = try JSONSerialization.data(
    withJSONObject: value,
    options: [.sortedKeys, .withoutEscapingSlashes]
  )
  guard data.count < maxFrameBytes, let value = String(data: data, encoding: .utf8) else {
    throw LauncherError.message("protocol frame is invalid")
  }
  return value + "\n"
}

private func selfTest() throws {
  var descriptors: [Int32] = [0, 0]
  guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
    throw LauncherError.message("self-test socket failed")
  }
  defer {
    close(descriptors[0])
    close(descriptors[1])
  }
  let frame = "{\"type\":\"self-test\"}\n"
  try writeFrame(frame, descriptors[0])
  guard try readFrame(descriptors[1]) == frame else {
    throw LauncherError.message("self-test frame changed")
  }
  guard
    try jsonFrame([
      "type": "configure", "entrypoint": "payload/worker", "memory_bytes": 64,
      "output_bytes": 32,
    ])
      == "{\"entrypoint\":\"payload/worker\",\"memory_bytes\":64,\"output_bytes\":32,"
      + "\"type\":\"configure\"}\n"
  else { throw LauncherError.message("self-test JSON changed") }
  print("shejane-managed-worker-vm: self-test ok")
}

signal(SIGPIPE, SIG_IGN)
do {
  if CommandLine.arguments.dropFirst() == ["--self-test"] {
    try selfTest()
  } else {
    let runner = try Runner(arguments: Arguments(Array(CommandLine.arguments.dropFirst())))
    runner.run()
  }
} catch {
  FileHandle.standardError.write(Data("shejane-managed-worker-vm: \(error)\n".utf8))
  exit(EXIT_FAILURE)
}
