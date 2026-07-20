//go:build linux && (arm64 || amd64)

package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	afVsock       = 40
	blkGetSize64  = 0x80081272
	artifactPort  = 10790
	cgroupRoot    = "/sys/fs/cgroup"
	controlPort   = 10789
	cpuMax        = "100000 100000"
	isoModulePath = "/modules/isofs.ko"
	systemRoot    = "/system"
	inputRoot     = systemRoot + "/input"
	maxFrameSize  = 1024 * 1024
	maxHeaderSize = 4096
	outputRoot    = systemRoot + "/output"
	packageRoot   = systemRoot + "/package"
	workerInput   = "/input"
	workerOutput  = "/output"
	workerPackage = "/package"
	workerCgroup  = cgroupRoot + "/worker"
	vmCIDAny      = ^uint32(0)
)

var (
	errWorkerCancelled         = errors.New("worker cancelled")
	errWorkerResourceExhausted = errors.New("worker resource exhausted")
	resourceExhaustedFrame     = []byte("{\"error\":{\"code\":\"resource_exhausted\",\"message\":\"worker memory limit exceeded\"},\"id\":2,\"jsonrpc\":\"2.0\"}\n")
	stoppedFrame               = []byte("{\"type\":\"stopped\"}\n")
	modulePaths                = []string{
		"/modules/vsock.ko",
		"/modules/vmw_vsock_virtio_transport_common.ko",
		"/modules/vmw_vsock_virtio_transport.ko",
	}
	filesystemModulePaths = []string{
		"/modules/virtio_blk.ko",
		"/modules/crc16.ko",
		"/modules/mbcache.ko",
		"/modules/jbd2.ko",
		"/modules/ext4.ko",
		"/modules/cdrom.ko",
		isoModulePath,
	}
)

type sockaddrVM struct {
	family    uint16
	reserved1 uint16
	port      uint32
	cid       uint32
	zero      [4]byte
}

type configureFrame struct {
	Entrypoint  string `json:"entrypoint"`
	MemoryBytes uint64 `json:"memory_bytes"`
	OutputBytes uint64 `json:"output_bytes"`
	Type        string `json:"type"`
}

type artifactReference struct {
	Path string `json:"path"`
}

type workerResponse struct {
	ID     int `json:"id"`
	Result *struct {
		Artifacts []artifactReference `json:"artifacts"`
	} `json:"result"`
}

type artifactHeader struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   uint64 `json:"size"`
}

func main() {
	fmt.Println("shejane-guestd: booted")
	scratchBytes := mountDisks()
	fmt.Printf("shejane-guestd: disks ready scratch_bytes=%d\n", scratchBytes)
	control, artifact, serialErr := openSerialChannels()
	if serialErr == nil {
		fmt.Println("shejane-guestd: virtio serial ready")
	} else if !errors.Is(serialErr, os.ErrNotExist) {
		fail("open virtio serial", serialErr)
	}
	if control == nil {
		control, artifact = openVsockChannels()
	}
	defer control.Close()
	defer artifact.Close()
	reader := bufio.NewReaderSize(control, maxFrameSize+1)
	readyFrame := fmt.Appendf(
		nil,
		"{\"input_read_only\":true,\"package_read_only\":true,\"protocol_version\":1,\"rootfs_read_only\":true,\"scratch_bytes\":%d,\"type\":\"ready\"}\n",
		scratchBytes,
	)
	if _, err := control.Write(readyFrame); err != nil {
		fail("write ready frame", err)
	}
	configuration := parseConfigureFrame(readFrame(reader))
	if configuration.OutputBytes > scratchBytes {
		fail("validate output limit", syscall.EOVERFLOW)
	}
	cgroup := configureCgroup(configuration.MemoryBytes)
	mountWorkerCgroupView()
	configuredFrame := fmt.Appendf(
		nil,
		"{\"cpu_max\":\"%s\",\"memory_bytes\":%d,\"output_bytes\":%d,\"pids_max\":16,\"type\":\"configured\"}\n",
		cpuMax,
		configuration.MemoryBytes,
		configuration.OutputBytes,
	)
	if _, err := control.Write(configuredFrame); err != nil {
		fail("write configured frame", err)
	}
	workerErr := runWorker(
		configuration.Entrypoint,
		control,
		reader,
		artifact,
		cgroup,
		configuration.OutputBytes,
	)
	cleanupWorkerCgroup()
	if workerErr != nil && !errors.Is(workerErr, errWorkerCancelled) &&
		!errors.Is(workerErr, errWorkerResourceExhausted) {
		fail("run worker", workerErr)
	}
	if _, err := control.Write(stoppedFrame); err != nil {
		fail("write stopped frame", err)
	}
	_ = control.Close()
	syscall.Sync()
	if err := syscall.Unmount(systemRoot+"/tmp", 0); err != nil {
		fail("unmount worker temporary directory", err)
	}
	if err := syscall.Unmount(outputRoot, 0); err != nil {
		fail("unmount scratch disk", err)
	}
	if err := syscall.Unmount(inputRoot, 0); err != nil {
		fail("unmount input disk", err)
	}
	if err := syscall.Unmount(packageRoot, 0); err != nil {
		fail("unmount package disk", err)
	}
	if err := syscall.Unmount(systemRoot+"/proc", 0); err != nil {
		fail("unmount worker proc filesystem", err)
	}
	if err := syscall.Unmount(systemRoot+"/dev", 0); err != nil {
		fail("unmount worker device filesystem", err)
	}
	if err := syscall.Unmount(systemRoot+cgroupRoot, 0); err != nil {
		fail("unmount worker cgroup view", err)
	}
	if err := syscall.Unmount(systemRoot, 0); err != nil {
		fail("unmount system disk", err)
	}
	if err := syscall.Unmount(cgroupRoot, 0); err != nil {
		fail("unmount cgroup filesystem", err)
	}
	if err := syscall.Unmount("/sys", 0); err != nil {
		fail("unmount sysfs", err)
	}
	if err := syscall.Unmount("/dev", 0); err != nil {
		fail("unmount device filesystem", err)
	}
	if err := syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF); err != nil {
		fail("power off guest", err)
	}
	for {
		time.Sleep(24 * time.Hour)
	}
}

func readFrame(reader *bufio.Reader) []byte {
	frame, err := nextFrame(reader, maxFrameSize)
	if err != nil {
		fail("read control frame", err)
	}
	return frame
}

func parseConfigureFrame(frame []byte) configureFrame {
	var configuration configureFrame
	decoder := json.NewDecoder(bytes.NewReader(frame))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&configuration); err != nil {
		fail("decode configure frame", err)
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF || hasDuplicateJSONKeys(frame) || configuration.Type != "configure" ||
		!validPackagePath(configuration.Entrypoint) ||
		configuration.MemoryBytes < 16<<20 || configuration.MemoryBytes > 8<<30 ||
		configuration.OutputBytes < 1<<20 || configuration.OutputBytes > 8<<30 {
		fail("validate configure frame", syscall.EPROTO)
	}
	entrypoint := packageRoot + "/" + configuration.Entrypoint
	current := packageRoot
	for _, part := range strings.Split(configuration.Entrypoint, "/") {
		current = filepath.Join(current, part)
		metadata, err := os.Lstat(current)
		if err != nil || metadata.Mode()&os.ModeSymlink != 0 {
			fail("validate worker entrypoint", err)
		}
	}
	metadata, err := os.Stat(entrypoint)
	if err != nil || !metadata.Mode().IsRegular() || metadata.Mode().Perm()&0o111 == 0 {
		fail("validate worker entrypoint", err)
	}
	return configuration
}

func hasDuplicateJSONKeys(frame []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(frame))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return true
	}
	seen := map[string]bool{}
	for decoder.More() {
		key, err := decoder.Token()
		name, ok := key.(string)
		if err != nil || !ok || seen[name] {
			return true
		}
		seen[name] = true
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return true
		}
	}
	_, err = decoder.Token()
	return err != nil
}

func validPackagePath(value string) bool {
	if value == "" || len(value) > 512 || strings.HasPrefix(value, "/") ||
		strings.ContainsAny(value, "\\\x00") || strings.Contains(value, "//") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func configureCgroup(memoryBytes uint64) *os.File {
	if err := os.MkdirAll(cgroupRoot, 0o755); err != nil {
		fail("create cgroup mount point", err)
	}
	flags := uintptr(syscall.MS_NODEV | syscall.MS_NOSUID | syscall.MS_NOEXEC)
	if err := syscall.Mount("none", cgroupRoot, "cgroup2", flags, ""); err != nil {
		fail("mount cgroup v2", err)
	}
	controllers, err := os.ReadFile(cgroupRoot + "/cgroup.controllers")
	if err != nil {
		fail("read cgroup controllers", err)
	}
	for _, required := range []string{"cpu", "memory", "pids"} {
		if !containsField(controllers, required) {
			fail("verify cgroup controllers", syscall.ENODEV)
		}
	}
	writeCgroupFile(cgroupRoot+"/cgroup.subtree_control", "+cpu +memory +pids")
	if err := os.Mkdir(workerCgroup, 0o755); err != nil {
		fail("create worker cgroup", err)
	}
	writeCgroupFile(workerCgroup+"/memory.max", strconv.FormatUint(memoryBytes, 10))
	writeCgroupFile(workerCgroup+"/memory.swap.max", "0")
	writeCgroupFile(workerCgroup+"/memory.oom.group", "1")
	writeCgroupFile(workerCgroup+"/pids.max", "16")
	writeCgroupFile(workerCgroup+"/cpu.max", cpuMax)
	verifyCgroupFile(workerCgroup+"/memory.max", strconv.FormatUint(memoryBytes, 10))
	verifyCgroupFile(workerCgroup+"/memory.swap.max", "0")
	verifyCgroupFile(workerCgroup+"/memory.oom.group", "1")
	verifyCgroupFile(workerCgroup+"/pids.max", "16")
	verifyCgroupFile(workerCgroup+"/cpu.max", cpuMax)
	cgroup, err := os.Open(workerCgroup)
	if err != nil {
		fail("open worker cgroup", err)
	}
	return cgroup
}

func mountWorkerCgroupView() {
	target := systemRoot + cgroupRoot
	metadata, err := os.Lstat(target)
	if err != nil || !metadata.IsDir() || metadata.Mode()&os.ModeSymlink != 0 {
		fail("verify worker cgroup mount point", err)
	}
	if err := syscall.Mount(cgroupRoot, target, "", syscall.MS_BIND, ""); err != nil {
		fail("bind worker cgroup view", err)
	}
	flags := uintptr(
		syscall.MS_BIND |
			syscall.MS_REMOUNT |
			syscall.MS_RDONLY |
			syscall.MS_NODEV |
			syscall.MS_NOSUID |
			syscall.MS_NOEXEC,
	)
	if err := syscall.Mount("", target, "", flags, ""); err != nil {
		fail("protect worker cgroup view", err)
	}
}

func runWorker(
	entrypoint string,
	control *os.File,
	controlReader *bufio.Reader,
	artifact *os.File,
	cgroup *os.File,
	outputBytes uint64,
) error {
	stderr, err := os.OpenFile(
		outputRoot+"/.shejane-worker.stderr",
		os.O_WRONLY|os.O_CREATE|os.O_EXCL,
		0o600,
	)
	if err != nil {
		_ = cgroup.Close()
		return err
	}
	defer stderr.Close()
	runtimeAssets, err := runtimeAssetEnvironment()
	if err != nil {
		_ = cgroup.Close()
		return err
	}
	path := workerPackage + "/" + entrypoint
	command := exec.Command(path)
	command.Dir = workerPackage
	command.Env = []string{
		"PATH=",
		"SHEJANE_PLUGIN_ACCESS_ISOLATED=1",
		"SHEJANE_PLUGIN_INPUT_ROOT=" + workerInput,
		"SHEJANE_PLUGIN_OUTPUT_ROOT=" + workerOutput,
		"SHEJANE_PLUGIN_RESOURCE_ISOLATED=1",
		"SHEJANE_PLUGIN_RUNTIME_ASSETS=" + runtimeAssets,
		"SHEJANE_PLUGIN_SANDBOXED=1",
		"TMPDIR=" + workerOutput + "/.tmp",
	}
	command.Stderr = stderr
	command.SysProcAttr = &syscall.SysProcAttr{
		Chroot:      systemRoot,
		Credential:  &syscall.Credential{Uid: 65534, Gid: 65534, NoSetGroups: true},
		Pdeathsig:   syscall.SIGKILL,
		Setpgid:     true,
		UseCgroupFD: true,
		CgroupFD:    int(cgroup.Fd()),
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		_ = cgroup.Close()
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = cgroup.Close()
		return err
	}
	if err := command.Start(); err != nil {
		_ = cgroup.Close()
		return err
	}
	_ = cgroup.Close()
	cancelled := make(chan struct{})
	workerDone := make(chan struct{})
	go func() {
		for {
			frame, err := nextFrame(controlReader, maxFrameSize)
			if err != nil || writeAll(stdin, frame) != nil {
				_ = stdin.Close()
				return
			}
			if isCancelFrame(frame) {
				close(cancelled)
				select {
				case <-workerDone:
				case <-time.After(50 * time.Millisecond):
					writeCgroupFile(workerCgroup+"/cgroup.kill", "1")
					_ = stdin.Close()
				}
				return
			}
		}
	}()
	workerReader := bufio.NewReaderSize(stdout, maxFrameSize+1)
	artifactReader := bufio.NewReaderSize(artifact, maxHeaderSize+1)
	for {
		frame, err := nextFrame(workerReader, maxFrameSize)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if err := exportArtifacts(frame, control, artifact, artifactReader, outputBytes); err != nil {
			return err
		}
		if err := writeAll(control, frame); err != nil {
			return err
		}
	}
	waitErr := command.Wait()
	close(workerDone)
	select {
	case <-cancelled:
		return errWorkerCancelled
	default:
	}
	if waitErr != nil {
		oomKills, err := cgroupCounter(workerCgroup+"/memory.events", "oom_kill")
		if err != nil {
			return errors.Join(waitErr, err)
		}
		if oomKills > 0 {
			if err := writeAll(control, resourceExhaustedFrame); err != nil {
				return err
			}
			return errWorkerResourceExhausted
		}
		if err := stderr.Sync(); err != nil {
			return errors.Join(waitErr, err)
		}
		if detail, err := readBoundedFile(outputRoot+"/.shejane-worker.stderr", 16*1024); err == nil && len(detail) > 0 {
			return fmt.Errorf("%w: %s", waitErr, strings.TrimSpace(string(detail)))
		}
	}
	return waitErr
}

func readBoundedFile(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, limit))
}

func isCancelFrame(frame []byte) bool {
	var request struct {
		JSONRPC string `json:"jsonrpc"`
		ID      int    `json:"id"`
		Method  string `json:"method"`
	}
	return json.Unmarshal(frame, &request) == nil && request.JSONRPC == "2.0" &&
		request.ID == 4 && request.Method == "cancel"
}

func cgroupCounter(path, name string) (uint64, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == name {
			return strconv.ParseUint(fields[1], 10, 64)
		}
	}
	return 0, syscall.EPROTO
}

func runtimeAssetEnvironment() (string, error) {
	path := packageRoot + "/.shejane-host/runtime-assets.json"
	metadata, err := os.Lstat(path)
	if err != nil || !metadata.Mode().IsRegular() || metadata.Mode()&os.ModeSymlink != 0 ||
		metadata.Size() < 2 || metadata.Size() > 64*1024 {
		return "", syscall.EPROTO
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	assets := map[string]string{}
	if err := json.Unmarshal(raw, &assets); err != nil || len(assets) > 64 {
		return "", syscall.EPROTO
	}
	canonical, err := json.Marshal(assets)
	if err != nil || !bytes.Equal(raw, canonical) {
		return "", syscall.EPROTO
	}
	for id, value := range assets {
		if id == "" || len(id) > 100 || strings.ContainsAny(id, "/\\\x00") ||
			value != workerPackage+"/.shejane-host/runtime-assets/"+id {
			return "", syscall.EPROTO
		}
	}
	return string(raw), nil
}

func exportArtifacts(
	frame []byte,
	control *os.File,
	artifact *os.File,
	artifactReader *bufio.Reader,
	outputBytes uint64,
) error {
	var response workerResponse
	if err := json.Unmarshal(frame, &response); err != nil || response.ID != 2 || response.Result == nil {
		return nil
	}
	references := response.Result.Artifacts
	if len(references) == 0 {
		return nil
	}
	if len(references) > 256 {
		return syscall.E2BIG
	}
	signal := fmt.Appendf(nil, "{\"count\":%d,\"type\":\"artifacts\"}\n", len(references))
	if err := writeAll(control, signal); err != nil {
		return err
	}
	seen := map[string]bool{}
	var total uint64
	for _, reference := range references {
		relative, ok := strings.CutPrefix(reference.Path, workerOutput+"/")
		if !ok || !validPackagePath(relative) || seen[relative] {
			return syscall.EPROTO
		}
		seen[relative] = true
		file, err := openOutputArtifact(relative)
		if err != nil {
			return err
		}
		metadata, err := file.Stat()
		if err != nil || !metadata.Mode().IsRegular() || metadata.Size() < 0 {
			_ = file.Close()
			return syscall.EPROTO
		}
		size := uint64(metadata.Size())
		if size > outputBytes-total {
			_ = file.Close()
			return syscall.EFBIG
		}
		total += size
		digest := sha256.New()
		if _, err := io.CopyN(digest, file, int64(size)); err != nil {
			_ = file.Close()
			return err
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			_ = file.Close()
			return err
		}
		header, err := json.Marshal(artifactHeader{
			Path:   relative,
			SHA256: fmt.Sprintf("%x", digest.Sum(nil)),
			Size:   size,
		})
		if err != nil || len(header)+1 > maxHeaderSize {
			_ = file.Close()
			return syscall.EPROTO
		}
		if err := writeAll(artifact, append(header, '\n')); err != nil {
			_ = file.Close()
			return err
		}
		if _, err := io.CopyN(artifact, file, int64(size)); err != nil {
			_ = file.Close()
			return err
		}
		if err := file.Close(); err != nil {
			return err
		}
	}
	if err := writeAll(artifact, []byte("{\"type\":\"end\"}\n")); err != nil {
		return err
	}
	ack, err := nextFrame(artifactReader, maxHeaderSize)
	if err != nil || string(ack) != "{\"type\":\"ack\"}\n" {
		return syscall.EPROTO
	}
	return nil
}

func openOutputArtifact(relative string) (*os.File, error) {
	directory, err := syscall.Open(
		outputRoot,
		syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
		0,
	)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(relative, "/")
	for _, part := range parts[:len(parts)-1] {
		next, err := syscall.Openat(
			directory,
			part,
			syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
			0,
		)
		_ = syscall.Close(directory)
		if err != nil {
			return nil, err
		}
		directory = next
	}
	descriptor, err := syscall.Openat(
		directory,
		parts[len(parts)-1],
		syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
		0,
	)
	_ = syscall.Close(directory)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(descriptor), relative)
	if file == nil {
		_ = syscall.Close(descriptor)
		return nil, syscall.EBADF
	}
	return file, nil
}

func nextFrame(reader *bufio.Reader, limit int) ([]byte, error) {
	frame, err := reader.ReadSlice('\n')
	if len(frame) > limit {
		return nil, syscall.EFBIG
	}
	return frame, err
}

func writeAll(writer io.Writer, value []byte) error {
	for len(value) > 0 {
		written, err := writer.Write(value)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		value = value[written:]
	}
	return nil
}

func cleanupWorkerCgroup() {
	writeCgroupFile(workerCgroup+"/cgroup.kill", "1")
	deadline := time.Now().Add(time.Second)
	for {
		events, err := os.ReadFile(workerCgroup + "/cgroup.events")
		if err != nil {
			fail("read worker cgroup events", err)
		}
		if strings.Contains(string(events), "populated 0") {
			break
		}
		if time.Now().After(deadline) {
			fail("drain worker cgroup", syscall.ETIMEDOUT)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := os.Remove(workerCgroup); err != nil {
		fail("remove worker cgroup", err)
	}
}

func writeCgroupFile(path, value string) {
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		fail("write cgroup policy", err)
	}
}

func verifyCgroupFile(path, expected string) {
	value, err := os.ReadFile(path)
	if err != nil || strings.TrimSpace(string(value)) != expected {
		fail("verify cgroup policy", err)
	}
}

func containsField(value []byte, expected string) bool {
	for _, field := range strings.Fields(string(value)) {
		if field == expected {
			return true
		}
	}
	return false
}

func mountDisks() uint64 {
	for _, directory := range []string{"/dev", "/sys", systemRoot} {
		if err := os.Mkdir(directory, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
			fail("create disk mount point", err)
		}
	}
	if err := syscall.Mount("devtmpfs", "/dev", "devtmpfs", syscall.MS_NOSUID, "mode=0755"); err != nil {
		fail("mount device filesystem", err)
	}
	if err := syscall.Mount("sysfs", "/sys", "sysfs", syscall.MS_NODEV|syscall.MS_NOSUID|syscall.MS_NOEXEC, ""); err != nil {
		fail("mount sysfs", err)
	}
	loadOptionalModules(filesystemModulePaths)
	readOnlyFlags := uintptr(syscall.MS_RDONLY | syscall.MS_NODEV | syscall.MS_NOSUID | syscall.MS_NOEXEC)
	packageFlags := uintptr(syscall.MS_RDONLY | syscall.MS_NODEV | syscall.MS_NOSUID)
	if err := syscall.Mount("/dev/vdd", systemRoot, "ext4", packageFlags, ""); err != nil {
		fail("mount system disk", err)
	}
	if err := os.WriteFile(systemRoot+"/.shejane-write-probe", []byte("denied"), 0o600); !errors.Is(err, syscall.EROFS) {
		fail("verify system disk is read-only", err)
	}
	for _, directory := range []string{
		packageRoot,
		inputRoot,
		outputRoot,
		systemRoot + "/dev",
		systemRoot + "/proc",
		systemRoot + "/tmp",
	} {
		metadata, err := os.Lstat(directory)
		if err != nil || !metadata.IsDir() || metadata.Mode()&os.ModeSymlink != 0 {
			fail("verify system mount point", err)
		}
	}
	if err := mountReadOnlyMedia("/dev/vda", packageRoot, packageFlags); err != nil {
		fail("mount package disk", err)
	}
	if err := os.WriteFile(packageRoot+"/.shejane-write-probe", []byte("denied"), 0o600); !errors.Is(err, syscall.EROFS) {
		fail("verify package disk is read-only", err)
	}
	if err := mountReadOnlyMedia("/dev/vdb", inputRoot, readOnlyFlags); err != nil {
		fail("mount input disk", err)
	}
	if err := os.WriteFile(inputRoot+"/.shejane-write-probe", []byte("denied"), 0o600); !errors.Is(err, syscall.EROFS) {
		fail("verify input disk is read-only", err)
	}
	writeFlags := uintptr(syscall.MS_NODEV | syscall.MS_NOSUID | syscall.MS_NOEXEC)
	if err := syscall.Mount("/dev/vdc", outputRoot, "ext4", writeFlags, ""); err != nil {
		fail("mount scratch disk", err)
	}
	probe := outputRoot + "/.shejane-write-probe"
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		fail("write scratch disk", err)
	}
	if err := os.Remove(probe); err != nil {
		fail("clean scratch disk probe", err)
	}
	if err := os.Chown(outputRoot, 65534, 65534); err != nil {
		fail("assign scratch disk", err)
	}
	if err := os.Chmod(outputRoot, 0o700); err != nil {
		fail("protect scratch disk", err)
	}
	temporary := outputRoot + "/.tmp"
	if err := os.Mkdir(temporary, 0o700); err != nil {
		fail("create worker temporary directory", err)
	}
	if err := os.Chown(temporary, 65534, 65534); err != nil {
		fail("assign worker temporary directory", err)
	}
	if err := syscall.Mount(temporary, systemRoot+"/tmp", "", syscall.MS_BIND, ""); err != nil {
		fail("mount worker temporary directory", err)
	}
	temporaryFlags := uintptr(
		syscall.MS_BIND |
			syscall.MS_REMOUNT |
			syscall.MS_NODEV |
			syscall.MS_NOSUID |
			syscall.MS_NOEXEC,
	)
	if err := syscall.Mount("", systemRoot+"/tmp", "", temporaryFlags, ""); err != nil {
		fail("protect worker temporary directory", err)
	}
	if err := syscall.Mount("devtmpfs", systemRoot+"/dev", "devtmpfs", syscall.MS_NOSUID, "mode=0755"); err != nil {
		fail("mount worker device filesystem", err)
	}
	procFlags := uintptr(syscall.MS_NODEV | syscall.MS_NOSUID | syscall.MS_NOEXEC)
	if err := syscall.Mount("proc", systemRoot+"/proc", "proc", procFlags, "hidepid=2"); err != nil {
		fail("mount worker proc filesystem", err)
	}
	var filesystem syscall.Statfs_t
	if err := syscall.Statfs(outputRoot, &filesystem); err != nil {
		fail("measure scratch disk", err)
	}
	deviceBytes := blockDeviceBytes("/dev/vdc")
	if filesystem.Blocks == 0 || filesystem.Blocks*uint64(filesystem.Bsize) > deviceBytes {
		fail("verify scratch filesystem size", syscall.EOVERFLOW)
	}
	return deviceBytes
}

func mountReadOnlyMedia(device, target string, flags uintptr) error {
	err := syscall.Mount(device, target, "ext4", flags, "")
	if !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENODEV) {
		return err
	}
	err = syscall.Mount(device, target, "iso9660", flags, "")
	if !errors.Is(err, syscall.ENODEV) && !errors.Is(err, syscall.EINVAL) {
		return err
	}
	if _, moduleErr := os.Stat(isoModulePath); moduleErr != nil {
		return err
	}
	if moduleErr := loadModule(isoModulePath); moduleErr != nil && !errors.Is(moduleErr, syscall.EEXIST) {
		return moduleErr
	}
	return syscall.Mount(device, target, "iso9660", flags, "")
}

func loadOptionalModules(paths []string) {
	if _, err := os.Stat(paths[0]); errors.Is(err, os.ErrNotExist) {
		return
	} else if err != nil {
		fail("inspect Guest module set", err)
	}
	for _, path := range paths {
		if err := loadModule(path); err != nil && !errors.Is(err, syscall.EEXIST) {
			fail("load Guest module", err)
		}
	}
}

func openSerialChannels() (*os.File, *os.File, error) {
	ports := map[string]string{}
	names, err := filepath.Glob("/sys/class/virtio-ports/*/name")
	if err != nil {
		return nil, nil, err
	}
	for _, path := range names {
		name, err := os.ReadFile(path)
		if err != nil {
			return nil, nil, err
		}
		ports[strings.TrimSpace(string(name))] = "/dev/" + filepath.Base(filepath.Dir(path))
	}
	controlPath, hasControl := ports["shejane.control"]
	artifactPath, hasArtifact := ports["shejane.artifacts"]
	if !hasControl && !hasArtifact {
		return nil, nil, os.ErrNotExist
	}
	if !hasControl || !hasArtifact {
		return nil, nil, syscall.EPROTO
	}
	control, err := os.OpenFile(controlPath, os.O_RDWR, 0)
	if err != nil {
		return nil, nil, err
	}
	artifact, err := os.OpenFile(artifactPath, os.O_RDWR, 0)
	if err != nil {
		control.Close()
		return nil, nil, err
	}
	return control, artifact, nil
}

func openVsockChannels() (*os.File, *os.File) {
	listener, err := openListener(controlPort)
	if err == syscall.EAFNOSUPPORT {
		for _, path := range modulePaths {
			if err := loadModule(path); err != nil {
				fail("load VSOCK module", err)
			}
		}
		listener, err = openListener(controlPort)
	}
	if err != nil {
		fail("open vsock", err)
	}
	defer syscall.Close(listener)
	artifactListener, err := openListener(artifactPort)
	if err != nil {
		fail("open artifact vsock", err)
	}
	defer syscall.Close(artifactListener)
	return acceptConnection(listener, "guest-control"), acceptConnection(artifactListener, "guest-artifacts")
}

func blockDeviceBytes(path string) uint64 {
	device, err := os.Open(path)
	if err != nil {
		fail("open scratch block device", err)
	}
	defer device.Close()
	var size uint64
	if _, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		device.Fd(),
		blkGetSize64,
		uintptr(unsafe.Pointer(&size)),
	); errno != 0 {
		fail("measure scratch block device", errno)
	}
	return size
}

func acceptConnection(listener int, name string) *os.File {
	connection, _, errno := syscall.Syscall6(
		syscall.SYS_ACCEPT4,
		uintptr(listener),
		0,
		0,
		syscall.SOCK_CLOEXEC,
		0,
		0,
	)
	if errno != 0 {
		fail("accept vsock", errno)
	}
	stream := os.NewFile(connection, name)
	if stream == nil {
		fail("open vsock stream", syscall.EBADF)
	}
	return stream
}

func openListener(port uint32) (int, error) {
	listener, err := syscall.Socket(afVsock, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	address := sockaddrVM{family: afVsock, port: port, cid: vmCIDAny}
	if _, _, errno := syscall.Syscall(
		syscall.SYS_BIND,
		uintptr(listener),
		uintptr(unsafe.Pointer(&address)),
		unsafe.Sizeof(address),
	); errno != 0 {
		_ = syscall.Close(listener)
		return -1, errno
	}
	if err := syscall.Listen(listener, 1); err != nil {
		_ = syscall.Close(listener)
		return -1, err
	}
	return listener, nil
}

func loadModule(path string) error {
	module, err := os.Open(path)
	if err != nil {
		return err
	}
	defer module.Close()
	parameters := []byte{0}
	_, _, errno := syscall.Syscall6(
		finitModuleSyscall(),
		module.Fd(),
		uintptr(unsafe.Pointer(&parameters[0])),
		0,
		0,
		0,
		0,
	)
	if errno != 0 {
		return errno
	}
	return nil
}

func finitModuleSyscall() uintptr {
	if runtime.GOARCH == "amd64" {
		return 313
	}
	return 273
}

func fail(operation string, err error) {
	if err == nil {
		err = io.ErrUnexpectedEOF
	}
	fmt.Fprintf(os.Stderr, "shejane-guestd: %s: %v\n", operation, err)
	syscall.Sync()
	_ = syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
	for {
		time.Sleep(24 * time.Hour)
	}
}
