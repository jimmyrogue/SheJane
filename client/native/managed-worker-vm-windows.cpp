#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00

#include <winsock2.h>
#include <windows.h>
#include <aclapi.h>
#include <userenv.h>
#include <ws2tcpip.h>

#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#ifdef _MSC_VER
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "ws2_32.lib")
#endif

namespace {

class Win32Error final : public std::runtime_error {
 public:
  Win32Error(const char* operation, DWORD code)
      : std::runtime_error(operation), code_(code) {}

  DWORD code() const { return code_; }

 private:
  DWORD code_;
};

class Handle final {
 public:
  Handle() = default;
  explicit Handle(HANDLE value) : value_(value) {}
  ~Handle() {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(other.release()) {}
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) {
      Handle temporary(other.release());
      std::swap(value_, temporary.value_);
    }
    return *this;
  }
  HANDLE get() const { return value_; }
  HANDLE release() {
    HANDLE value = value_;
    value_ = nullptr;
    return value;
  }

 private:
  HANDLE value_ = nullptr;
};

class Profile final {
 public:
  explicit Profile(std::wstring name) : name_(std::move(name)) {
    HRESULT result = CreateAppContainerProfile(
        name_.c_str(), L"SheJane Managed Worker", L"Ephemeral Managed Worker VMM", nullptr, 0,
        &sid_);
    if (FAILED(result)) {
      throw Win32Error("CreateAppContainerProfile", HRESULT_CODE(result));
    }
  }
  ~Profile() {
    if (sid_ != nullptr) LocalFree(sid_);
    if (!name_.empty()) DeleteAppContainerProfile(name_.c_str());
  }
  Profile(const Profile&) = delete;
  Profile& operator=(const Profile&) = delete;
  PSID sid() const { return sid_; }

 private:
  std::wstring name_;
  PSID sid_ = nullptr;
};

[[noreturn]] void throw_last_error(const char* operation) {
  throw Win32Error(operation, GetLastError());
}

std::filesystem::path executable_path() {
  std::vector<wchar_t> buffer(32'768);
  DWORD size = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (size == 0 || size >= buffer.size()) throw_last_error("GetModuleFileNameW");
  return std::filesystem::path(std::wstring(buffer.data(), size));
}

std::filesystem::path unique_temp_path(const wchar_t* suffix) {
  std::vector<wchar_t> buffer(32'768);
  DWORD size = GetTempPathW(static_cast<DWORD>(buffer.size()), buffer.data());
  if (size == 0 || size >= buffer.size()) throw_last_error("GetTempPathW");
  std::wstring name = L"shejane-managed-worker-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
                      std::to_wstring(GetTickCount64()) + L"-" + suffix;
  return std::filesystem::path(std::wstring(buffer.data(), size)) / name;
}

void grant_path(PSID sid, const std::filesystem::path& path, DWORD access, DWORD inheritance) {
  PACL old_acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD result = GetNamedSecurityInfoW(
      const_cast<wchar_t*>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
      nullptr, &old_acl, nullptr, &descriptor);
  if (result != ERROR_SUCCESS) throw Win32Error("GetNamedSecurityInfoW", result);

  EXPLICIT_ACCESSW entry{};
  entry.grfAccessPermissions = access;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.grfInheritance = inheritance;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
  entry.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);

  PACL new_acl = nullptr;
  result = SetEntriesInAclW(1, &entry, old_acl, &new_acl);
  if (result == ERROR_SUCCESS) {
    result = SetNamedSecurityInfoW(
        const_cast<wchar_t*>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
        nullptr, new_acl, nullptr);
  }
  if (new_acl != nullptr) LocalFree(new_acl);
  if (descriptor != nullptr) LocalFree(descriptor);
  if (result != ERROR_SUCCESS) throw Win32Error("grant AppContainer path", result);
}

std::wstring quote(const std::filesystem::path& path) {
  std::wstring value = path.wstring();
  std::wstring quoted = L"\"";
  size_t backslashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
    } else if (character == L'\"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(character);
      backslashes = 0;
    } else {
      quoted.append(backslashes, L'\\');
      quoted.push_back(character);
      backslashes = 0;
    }
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

Handle create_job() {
  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (job.get() == nullptr) throw_last_error("CreateJobObjectW");

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
                                             JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
                                             JOB_OBJECT_LIMIT_JOB_MEMORY;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  limits.JobMemoryLimit = 128ULL * 1024ULL * 1024ULL;
  if (!SetInformationJobObject(
          job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    throw_last_error("SetInformationJobObject limits");
  }

  JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
  cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
  cpu.CpuRate = 2'000;
  if (!SetInformationJobObject(job.get(), JobObjectCpuRateControlInformation, &cpu, sizeof(cpu))) {
    throw_last_error("SetInformationJobObject CPU");
  }
  return job;
}

void verify_job(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  if (!QueryInformationJobObject(
          job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr)) {
    throw_last_error("QueryInformationJobObject limits");
  }
  const DWORD expected = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
                         JOB_OBJECT_LIMIT_JOB_MEMORY;
  if ((limits.BasicLimitInformation.LimitFlags & expected) != expected ||
      limits.BasicLimitInformation.ActiveProcessLimit != 1 ||
      limits.JobMemoryLimit != 128ULL * 1024ULL * 1024ULL) {
    throw Win32Error("Job limits changed", ERROR_INVALID_DATA);
  }
  JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
  if (!QueryInformationJobObject(
          job, JobObjectCpuRateControlInformation, &cpu, sizeof(cpu), nullptr)) {
    throw_last_error("QueryInformationJobObject CPU");
  }
  const DWORD expected_cpu_flags =
      JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
  if ((cpu.ControlFlags & expected_cpu_flags) != expected_cpu_flags || cpu.CpuRate != 2'000) {
    throw Win32Error("Job CPU limits changed", ERROR_INVALID_DATA);
  }
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(
          job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) {
    throw_last_error("QueryInformationJobObject accounting");
  }
  if (accounting.ActiveProcesses != 0 || accounting.TotalProcesses != 1) {
    throw Win32Error("Job cleanup changed", ERROR_INVALID_DATA);
  }
}

int network_denial_error() {
  WSADATA data{};
  const int startup_error = WSAStartup(MAKEWORD(2, 2), &data);
  // An LPAC without registryRead can be blocked while Winsock loads its
  // protocol catalog, before a socket exists. Windows reports that denial as
  // WSASYSCALLFAILURE rather than WSAEACCES.
  if (startup_error == WSASYSCALLFAILURE) return 0;
  if (startup_error != 0) return startup_error;
  SOCKET socket_handle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (socket_handle == INVALID_SOCKET) {
    const int error = WSAGetLastError();
    WSACleanup();
    return error == WSAEACCES ? 0 : error;
  }
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(9);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  const int connected = connect(
      socket_handle, reinterpret_cast<const sockaddr*>(&address), sizeof(address));
  const int error = connected == SOCKET_ERROR ? WSAGetLastError() : 0;
  closesocket(socket_handle);
  WSACleanup();
  if (connected != SOCKET_ERROR) return WSAEISCONN;
  return error == WSAEACCES ? 0 : error;
}

bool read_exact(HANDLE handle, void* buffer, DWORD size) {
  auto* cursor = static_cast<unsigned char*>(buffer);
  DWORD total = 0;
  while (total < size) {
    DWORD received = 0;
    if (!ReadFile(handle, cursor + total, size - total, &received, nullptr) || received == 0) {
      return false;
    }
    total += received;
  }
  return true;
}

bool write_exact(HANDLE handle, const void* buffer, DWORD size) {
  const auto* cursor = static_cast<const unsigned char*>(buffer);
  DWORD total = 0;
  while (total < size) {
    DWORD written = 0;
    if (!WriteFile(handle, cursor + total, size - total, &written, nullptr) || written == 0) {
      return false;
    }
    total += written;
  }
  return true;
}

int probe(const std::filesystem::path& denied_path, const std::wstring& pipe_name) {
  Handle token;
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) return 10;
  token = Handle(raw_token);
  DWORD is_app_container = 0;
  DWORD is_lpac = 0;
  DWORD returned = 0;
  if (!GetTokenInformation(
          token.get(), TokenIsAppContainer, &is_app_container, sizeof(is_app_container),
          &returned)) {
    return 21;
  }
  if (is_app_container != 1) return 22;
  if (!GetTokenInformation(
          token.get(), TokenIsLessPrivilegedAppContainer, &is_lpac, sizeof(is_lpac),
          &returned)) {
    const DWORD error = GetLastError();
    if (error != ERROR_INVALID_PARAMETER) return 2'300 + static_cast<int>(error);

    // Older Windows kernels do not expose TokenIsLessPrivilegedAppContainer.
    // LPACs without registryRead must still be denied the registry keys that a
    // regular AppContainer can read through ALL_APPLICATION_PACKAGES.
    HKEY registry_key = nullptr;
    const LSTATUS registry_status =
        RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE", 0, KEY_READ, &registry_key);
    if (registry_status == ERROR_SUCCESS) {
      RegCloseKey(registry_key);
      return 24;
    }
    if (registry_status != ERROR_ACCESS_DENIED) {
      return 2'500 + static_cast<int>(registry_status);
    }
    is_lpac = 1;
  }
  if (is_lpac != 1) return 24;
  Handle denied(CreateFileW(
      denied_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL, nullptr));
  if (denied.get() != INVALID_HANDLE_VALUE) return 12;
  if (GetLastError() != ERROR_ACCESS_DENIED && GetLastError() != ERROR_FILE_NOT_FOUND) return 13;
  const int network_error = network_denial_error();
  if (network_error != 0) return 4'000 + network_error;

  const std::filesystem::path executable = executable_path();
  std::wstring command = quote(executable) + L" --grandchild";
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (CreateProcessW(
          executable.c_str(), mutable_command.data(), nullptr, nullptr, FALSE,
          CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
    Handle process_handle(process.hProcess);
    Handle thread_handle(process.hThread);
    TerminateProcess(process_handle.get(), ERROR_ACCESS_DENIED);
    WaitForSingleObject(process_handle.get(), 5'000);
    return 15;
  }
  if (GetLastError() != ERROR_ACCESS_DENIED) return 16;

  Handle pipe(CreateNamedPipeW(
      pipe_name.c_str(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1,
      4'096, 4'096, 10'000, nullptr));
  if (pipe.get() == INVALID_HANDLE_VALUE) return 17;
  if (!ConnectNamedPipe(pipe.get(), nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) return 18;
  constexpr char challenge[] = "host";
  constexpr char response[] = "guest";
  char received[sizeof(challenge)]{};
  if (!read_exact(pipe.get(), received, sizeof(received)) ||
      std::string(received, sizeof(received)) != std::string(challenge, sizeof(challenge))) {
    return 19;
  }
  if (!write_exact(pipe.get(), response, sizeof(response))) return 20;
  return 0;
}

std::vector<std::wstring> app_container_pipe_names(PSID sid, const std::wstring& name) {
  ULONG required = 0;
  GetAppContainerNamedObjectPath(nullptr, sid, 0, nullptr, &required);
  if (required == 0) throw_last_error("GetAppContainerNamedObjectPath size");
  std::vector<wchar_t> buffer(required);
  if (!GetAppContainerNamedObjectPath(nullptr, sid, required, buffer.data(), &required)) {
    throw_last_error("GetAppContainerNamedObjectPath");
  }
  std::wstring path(buffer.data());
  if (path.empty() || path.front() != L'\\') path.insert(path.begin(), L'\\');
  return {
      L"\\\\.\\pipe\\LOCAL\\" + name,
      L"\\\\.\\pipe" + path + L"\\" + name,
      L"\\\\.\\pipe" + path + L"\\LOCAL\\" + name,
  };
}

Handle connect_pipe(
    const std::vector<std::wstring>& pipe_names, HANDLE child, DWORD timeout_milliseconds) {
  const ULONGLONG deadline = GetTickCount64() + timeout_milliseconds;
  while (GetTickCount64() < deadline) {
    for (const std::wstring& pipe_name : pipe_names) {
      HANDLE pipe = CreateFileW(
          pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
          FILE_ATTRIBUTE_NORMAL, nullptr);
      if (pipe != INVALID_HANDLE_VALUE) return Handle(pipe);
      const DWORD error = GetLastError();
      if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PIPE_BUSY &&
          error != ERROR_ACCESS_DENIED) {
        throw Win32Error("connect LPAC named pipe", error);
      }
      if (error == ERROR_PIPE_BUSY) WaitNamedPipeW(pipe_name.c_str(), 100);
    }
    const DWORD child_state = WaitForSingleObject(child, 0);
    if (child_state == WAIT_OBJECT_0) {
      DWORD exit_code = ERROR_INVALID_DATA;
      if (!GetExitCodeProcess(child, &exit_code)) throw_last_error("GetExitCodeProcess");
      throw Win32Error("LPAC probe exited before named pipe", exit_code);
    }
    if (child_state == WAIT_FAILED) throw_last_error("WaitForSingleObject LPAC probe");
    Sleep(10);
  }
  throw Win32Error("connect LPAC named pipe", ERROR_TIMEOUT);
}

void self_test() {
  const std::filesystem::path staging = unique_temp_path(L"staging");
  const std::filesystem::path denied_directory = unique_temp_path(L"denied");
  std::filesystem::create_directory(staging);
  std::filesystem::create_directory(denied_directory);
  const std::filesystem::path denied_file = denied_directory / L"host-secret.txt";
  const std::filesystem::path probe_path = staging / L"probe.exe";
  try {
    {
      Handle secret(CreateFileW(
          denied_file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
          nullptr));
      if (secret.get() == INVALID_HANDLE_VALUE) throw_last_error("create host secret");
    }
    if (!CopyFileW(executable_path().c_str(), probe_path.c_str(), TRUE)) {
      throw_last_error("CopyFileW probe");
    }

    Profile profile(
        L"SheJane.ManagedWorker." + std::to_wstring(GetCurrentProcessId()) + L"." +
        std::to_wstring(GetTickCount64()));
    grant_path(
        profile.sid(), staging, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
    grant_path(profile.sid(), probe_path, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, NO_INHERITANCE);
    Handle job = create_job();
    const std::wstring pipe_stem =
        L"SheJane.ManagedWorker." + std::to_wstring(GetCurrentProcessId()) + L"." +
        std::to_wstring(GetTickCount64());
    const std::wstring child_pipe_name = L"\\\\.\\pipe\\LOCAL\\" + pipe_stem;
    const std::vector<std::wstring> host_pipe_names =
        app_container_pipe_names(profile.sid(), pipe_stem);

    SIZE_T attribute_bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &attribute_bytes);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
      throw_last_error("size process attributes");
    }
    std::vector<unsigned char> attribute_storage(attribute_bytes);
    auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
    if (!InitializeProcThreadAttributeList(attributes, 2, 0, &attribute_bytes)) {
      throw_last_error("InitializeProcThreadAttributeList");
    }
    SECURITY_CAPABILITIES capabilities{};
    capabilities.AppContainerSid = profile.sid();
    DWORD all_application_packages = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    if (!UpdateProcThreadAttribute(
            attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities,
            sizeof(capabilities), nullptr, nullptr) ||
        !UpdateProcThreadAttribute(
            attributes, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
            &all_application_packages, sizeof(all_application_packages), nullptr, nullptr)) {
      DeleteProcThreadAttributeList(attributes);
      throw_last_error("UpdateProcThreadAttribute");
    }

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION process{};
    std::wstring command =
        quote(probe_path) + L" --probe " + quote(denied_file) + L" " +
        quote(std::filesystem::path(child_pipe_name));
    std::vector<wchar_t> mutable_command(command.begin(), command.end());
    mutable_command.push_back(L'\0');
    BOOL created = CreateProcessW(
        probe_path.c_str(), mutable_command.data(), nullptr, nullptr, FALSE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
            CREATE_NO_WINDOW,
        nullptr, staging.c_str(), reinterpret_cast<LPSTARTUPINFOW>(&startup), &process);
    DeleteProcThreadAttributeList(attributes);
    if (!created) throw_last_error("CreateProcessW LPAC probe");
    Handle process_handle(process.hProcess);
    Handle thread_handle(process.hThread);
    if (!AssignProcessToJobObject(job.get(), process_handle.get())) {
      TerminateProcess(process_handle.get(), ERROR_ACCESS_DENIED);
      throw_last_error("AssignProcessToJobObject");
    }
    if (ResumeThread(thread_handle.get()) == static_cast<DWORD>(-1)) {
      TerminateJobObject(job.get(), ERROR_INVALID_STATE);
      throw_last_error("ResumeThread");
    }
    Handle pipe = connect_pipe(host_pipe_names, process_handle.get(), 10'000);
    constexpr char challenge[] = "host";
    constexpr char response[] = "guest";
    char received[sizeof(response)]{};
    if (!write_exact(pipe.get(), challenge, sizeof(challenge)) ||
        !read_exact(pipe.get(), received, sizeof(received)) ||
        std::string(received, sizeof(received)) != std::string(response, sizeof(response))) {
      TerminateJobObject(job.get(), ERROR_INVALID_DATA);
      throw Win32Error("LPAC named pipe exchange", ERROR_INVALID_DATA);
    }
    pipe = Handle();
    DWORD wait = WaitForSingleObject(process_handle.get(), 30'000);
    if (wait != WAIT_OBJECT_0) {
      TerminateJobObject(job.get(), ERROR_TIMEOUT);
      throw Win32Error("LPAC probe timed out", wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError());
    }
    DWORD exit_code = ERROR_INVALID_DATA;
    if (!GetExitCodeProcess(process_handle.get(), &exit_code)) {
      throw_last_error("GetExitCodeProcess");
    }
    process_handle = Handle();
    thread_handle = Handle();
    if (exit_code != 0) throw Win32Error("LPAC probe failed", exit_code);
    verify_job(job.get());
  } catch (...) {
    std::error_code ignored;
    std::filesystem::remove_all(staging, ignored);
    std::filesystem::remove_all(denied_directory, ignored);
    throw;
  }
  std::filesystem::remove_all(staging);
  std::filesystem::remove_all(denied_directory);
  std::wcout << L"shejane-managed-worker-vm: Windows LPAC/Job self-test ok\n";
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 2 && std::wstring(argv[1]) == L"--self-test") {
      self_test();
      return 0;
    }
    if (argc == 4 && std::wstring(argv[1]) == L"--probe") {
      return probe(argv[2], argv[3]);
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--grandchild") {
      return 0;
    }
    std::wcerr << L"usage: shejane-managed-worker-vm.exe --self-test\n";
    return ERROR_BAD_ARGUMENTS;
  } catch (const Win32Error& error) {
    std::cerr << "shejane-managed-worker-vm: " << error.what() << " failed (" << error.code()
              << ")\n";
    return static_cast<int>(error.code() == 0 ? ERROR_INVALID_FUNCTION : error.code());
  } catch (const std::exception& error) {
    std::cerr << "shejane-managed-worker-vm: " << error.what() << "\n";
    return ERROR_INVALID_FUNCTION;
  }
}
