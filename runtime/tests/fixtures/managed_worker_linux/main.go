package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type request struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      int            `json:"id"`
	Method  string         `json:"method"`
	Params  map[string]any `json:"params"`
}

func main() {
	if os.Getenv("SHEJANE_TMP_EXEC_CHILD") == "1" {
		return
	}
	if os.Getenv("SHEJANE_ESCAPE_CHILD") == "1" {
		hostPID, err := strconv.Atoi(os.Getenv("SHEJANE_ESCAPE_HOST_PID"))
		if err != nil {
			fatal("descendant host PID probe is invalid")
		}
		probeHostIsolation(map[string]any{"host_probes": map[string]any{
			"secret_path":      os.Getenv("SHEJANE_ESCAPE_SECRET_PATH"),
			"credential_path":  os.Getenv("SHEJANE_ESCAPE_CREDENTIAL_PATH"),
			"unix_socket_path": os.Getenv("SHEJANE_ESCAPE_UNIX_SOCKET_PATH"),
			"tcp_address":      os.Getenv("SHEJANE_ESCAPE_TCP_ADDRESS"),
			"host_pid":         float64(hostPID),
		}})
		return
	}
	if os.Getenv("SHEJANE_PID_CHILD") == "1" {
		for {
			time.Sleep(time.Hour)
		}
	}
	if os.Getenv("SHEJANE_MEMORY_CHILD") == "1" {
		memory := make([]byte, 64*1024*1024)
		for index := 0; index < len(memory); index += 4096 {
			memory[index] = 1
		}
		runtime.KeepAlive(memory)
		fatal("worker descendant exceeded its memory limit")
	}
	if os.Getenv("SHEJANE_PLUGIN_LINUX_NATIVE") == "1" {
		runLinuxNativeFixture()
		return
	}
	if os.Getuid() != 65534 || os.Getgid() != 65534 {
		fatal("worker did not drop privileges")
	}
	for _, name := range []string{
		"SHEJANE_PLUGIN_ACCESS_ISOLATED",
		"SHEJANE_PLUGIN_RESOURCE_ISOLATED",
		"SHEJANE_PLUGIN_SANDBOXED",
	} {
		if os.Getenv(name) != "1" {
			fatal("worker isolation environment changed")
		}
	}
	processes, err := os.ReadFile("/sys/fs/cgroup/worker/cgroup.procs")
	if err != nil || !strings.Contains(string(processes), strconv.Itoa(os.Getpid())) {
		fatal("worker is outside its cgroup")
	}
	if err := os.WriteFile("/sys/fs/cgroup/worker/memory.max", []byte("max"), 0o600); err == nil {
		fatal("worker changed its cgroup policy")
	}
	decoder := json.NewDecoder(bufio.NewReader(os.Stdin))
	encoder := json.NewEncoder(os.Stdout)

	initialize := read(decoder, "initialize", 1)
	respond(encoder, initialize.ID, map[string]any{
		"protocol_version":  1,
		"process_isolated":  true,
		"access_isolated":   true,
		"resource_isolated": true,
		"sandboxed":         true,
	})

	invoke := read(decoder, "invoke", 2)
	if invoke.Params["mode"] == "crash" {
		os.Exit(77)
	}
	if invoke.Params["mode"] == "cancel" {
		if err := encoder.Encode(map[string]any{
			"jsonrpc": "2.0",
			"method":  "notifications/progress",
			"params": map[string]any{
				"schema_version": 1,
				"invocation_id":  invoke.Params["invocation_id"],
				"operation_id":   invoke.Params["operation_id"],
				"sequence":       1,
				"phase":          "blocked",
			},
		}); err != nil {
			fatal("worker progress failed")
		}
		for {
			time.Sleep(time.Hour)
		}
	}
	if invoke.Params["mode"] == "invalid_json" {
		fmt.Println("not-json")
		for {
			time.Sleep(time.Hour)
		}
	}
	if invoke.Params["mode"] == "failed" {
		respond(encoder, invoke.ID, map[string]any{
			"invocation_id": invoke.Params["invocation_id"],
			"operation_id":  invoke.Params["operation_id"],
			"status":        "failed",
			"artifacts":     []map[string]any{},
			"error":         map[string]any{"code": "fixture_failed"},
		})
		shutdown := read(decoder, "shutdown", 3)
		respond(encoder, shutdown.ID, map[string]any{})
		return
	}
	if invoke.Params["mode"] == "escape_probe" {
		result := probeHostIsolation(invoke.Params)
		probeDescendantIsolation(invoke.Params)
		result["descendant_isolated"] = true
		respond(encoder, invoke.ID, map[string]any{
			"invocation_id": invoke.Params["invocation_id"],
			"operation_id":  invoke.Params["operation_id"],
			"status":        "succeeded",
			"output":        result,
			"artifacts":     []map[string]any{},
		})
		shutdown := read(decoder, "shutdown", 3)
		respond(encoder, shutdown.ID, map[string]any{})
		return
	}
	inputRoot := os.Getenv("SHEJANE_PLUGIN_INPUT_ROOT")
	outputRoot := os.Getenv("SHEJANE_PLUGIN_OUTPUT_ROOT")
	input, err := os.ReadFile(inputRoot + "/probe.txt")
	if err != nil {
		fatal("worker cannot read authorized input")
	}
	if err := os.WriteFile(inputRoot+"/denied", []byte("denied"), 0o600); err == nil {
		fatal("worker wrote its input disk")
	}
	if err := syscall.Mount("", inputRoot, "", syscall.MS_REMOUNT, "rw"); err == nil {
		fatal("worker remounted its input disk")
	}
	if err := os.WriteFile("/package/denied", []byte("denied"), 0o600); err == nil {
		fatal("worker wrote its package disk")
	}
	if invoke.Params["mode"] == "temporary_mount" {
		marker := "/tmp/shejane-private-probe"
		if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
			fatal("worker temporary directory was not private")
		}
		if err := os.WriteFile(marker, []byte("private"), 0o600); err != nil {
			fatal("worker temporary directory was not writable")
		}
		aliased, err := os.ReadFile(outputRoot + "/.tmp/shejane-private-probe")
		if err != nil || string(aliased) != "private" {
			fatal("worker temporary directory did not use bounded scratch")
		}
		if err := os.WriteFile("/etc/shejane-denied", []byte("denied"), 0o600); err == nil {
			fatal("worker root filesystem became writable")
		}
		worker, err := os.ReadFile(os.Args[0])
		if err != nil {
			fatal("worker executable could not be read")
		}
		executable := "/tmp/shejane-exec-probe"
		if err := os.WriteFile(executable, worker, 0o700); err != nil {
			fatal("worker temporary executable could not be staged")
		}
		child := exec.Command(executable)
		child.Env = append(os.Environ(), "SHEJANE_TMP_EXEC_CHILD=1")
		if output, err := child.CombinedOutput(); err == nil {
			fatal("worker executed from temporary mount: " + strings.TrimSpace(string(output)))
		}
		respond(encoder, invoke.ID, map[string]any{
			"invocation_id": invoke.Params["invocation_id"],
			"operation_id":  invoke.Params["operation_id"],
			"status":        "succeeded",
			"output": map[string]any{
				"private":            true,
				"rootfs_read_only":   true,
				"scratch_backed":     true,
				"temporary_noexec":   true,
				"temporary_writable": true,
			},
			"artifacts": []map[string]any{},
		})
		shutdown := read(decoder, "shutdown", 3)
		respond(encoder, shutdown.ID, map[string]any{})
		return
	}
	if invoke.Params["mode"] == "scratch_enospc" {
		fill, err := os.Create(outputRoot + "/fill.bin")
		if err != nil {
			fatal("worker cannot create scratch filler")
		}
		block := make([]byte, 4096)
		for err == nil {
			_, err = fill.Write(block)
		}
		_ = fill.Close()
		if !errors.Is(err, syscall.ENOSPC) {
			fatal("worker scratch did not reach ENOSPC")
		}
		_ = os.Remove(outputRoot + "/fill.bin")
		respond(encoder, invoke.ID, map[string]any{
			"invocation_id": invoke.Params["invocation_id"],
			"operation_id":  invoke.Params["operation_id"],
			"status":        "succeeded",
			"output":        map[string]any{"enospc": true},
			"artifacts":     []map[string]any{},
		})
		shutdown := read(decoder, "shutdown", 3)
		respond(encoder, shutdown.ID, map[string]any{})
		return
	}
	if invoke.Params["mode"] == "memory_oom" {
		child := exec.Command(os.Args[0])
		child.Env = append(os.Environ(), "SHEJANE_MEMORY_CHILD=1")
		if err := child.Start(); err != nil {
			fatal("worker memory descendant did not start")
		}
		for {
			time.Sleep(time.Hour)
		}
	}
	if invoke.Params["mode"] == "pids_limit" {
		limited := false
		for range 32 {
			child := exec.Command(os.Args[0])
			child.Env = append(os.Environ(), "SHEJANE_PID_CHILD=1")
			if err := child.Start(); err != nil {
				if errors.Is(err, syscall.EAGAIN) {
					limited = true
					break
				}
				fatal("worker descendant start failed unexpectedly")
			}
		}
		if !limited {
			fatal("worker exceeded its process limit")
		}
		respond(encoder, invoke.ID, map[string]any{
			"invocation_id": invoke.Params["invocation_id"],
			"operation_id":  invoke.Params["operation_id"],
			"status":        "succeeded",
			"output":        map[string]any{"pids_limited": true},
			"artifacts":     []map[string]any{},
		})
		shutdown := read(decoder, "shutdown", 3)
		respond(encoder, shutdown.ID, map[string]any{})
		return
	}
	output := []byte("processed:" + string(input))
	if invoke.Params["mode"] == "artifact_symlink" {
		if err := os.Symlink(inputRoot+"/probe.txt", outputRoot+"/result.txt"); err != nil {
			fatal("worker cannot create hostile artifact")
		}
	} else if invoke.Params["mode"] == "artifact_oversized" {
		file, err := os.Create(outputRoot + "/result.txt")
		if err != nil {
			fatal("worker cannot create oversized artifact")
		}
		block := make([]byte, 4096)
		for range 512 {
			if _, err := file.Write(block); err != nil {
				fatal("worker cannot write oversized artifact")
			}
		}
		if err := file.Close(); err != nil {
			fatal("worker cannot close oversized artifact")
		}
	} else {
		if err := os.WriteFile(outputRoot+"/result.txt", output, 0o600); err != nil {
			fatal("worker cannot write scratch")
		}
	}
	respond(encoder, invoke.ID, map[string]any{
		"invocation_id": invoke.Params["invocation_id"],
		"operation_id":  invoke.Params["operation_id"],
		"status":        "succeeded",
		"output":        map[string]any{"text": string(output)},
		"artifacts": []map[string]any{{
			"path":       "/output/result.txt",
			"media_type": "text/plain",
			"name":       "result.txt",
		}},
	})

	shutdown := read(decoder, "shutdown", 3)
	respond(encoder, shutdown.ID, map[string]any{})
}

func runLinuxNativeFixture() {
	for _, name := range []string{
		"SHEJANE_PLUGIN_ACCESS_ISOLATED",
		"SHEJANE_PLUGIN_RESOURCE_ISOLATED",
		"SHEJANE_PLUGIN_SANDBOXED",
	} {
		if os.Getenv(name) != "1" {
			fatal("worker isolation environment changed")
		}
	}
	decoder := json.NewDecoder(bufio.NewReader(os.Stdin))
	encoder := json.NewEncoder(os.Stdout)
	initialize := read(decoder, "initialize", 1)
	respond(encoder, initialize.ID, map[string]any{
		"protocol_version":  1,
		"process_isolated":  true,
		"access_isolated":   true,
		"resource_isolated": true,
		"sandboxed":         true,
	})
	invoke := read(decoder, "invoke", 2)
	if invoke.Params["mode"] != "linux_native_gate" {
		fatal("Linux native fixture mode changed")
	}
	inputRoot := os.Getenv("SHEJANE_PLUGIN_INPUT_ROOT")
	outputRoot := os.Getenv("SHEJANE_PLUGIN_OUTPUT_ROOT")
	input, err := os.ReadFile(inputRoot + "/probe.txt")
	if err != nil {
		fatal("worker cannot read authorized input")
	}
	if err := os.WriteFile(inputRoot+"/denied", []byte("denied"), 0o600); err == nil {
		fatal("worker wrote its input")
	}
	if err := os.WriteFile("/package/denied", []byte("denied"), 0o600); err == nil {
		fatal("worker wrote its package")
	}
	if err := os.WriteFile("/etc/shejane-denied", []byte("denied"), 0o600); err == nil {
		fatal("worker wrote its root filesystem")
	}
	probeHostIsolation(invoke.Params)
	if descriptor, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0); err == nil {
		_ = syscall.Close(descriptor)
		fatal("worker created a network socket")
	} else if !errors.Is(err, syscall.EPERM) {
		fatal("worker network socket was not blocked by seccomp")
	}
	if err := syscall.Unshare(syscall.CLONE_NEWUSER); !errors.Is(err, syscall.EPERM) {
		fatal("worker created a nested user namespace")
	}
	brokerPID, err := strconv.Atoi(os.Getenv("SHEJANE_PLUGIN_BROKER_PID"))
	if err != nil || brokerPID < 1 {
		fatal("worker broker PID is invalid")
	}
	brokerFD, err := strconv.Atoi(os.Getenv("SHEJANE_PLUGIN_BROKER_OUTPUT_FD"))
	if err != nil || brokerFD < 3 {
		fatal("worker broker output descriptor is invalid")
	}
	if _, err := os.Open(fmt.Sprintf("/proc/%d/fd/%d", brokerPID, brokerFD)); err == nil {
		fatal("worker opened the broker host output descriptor")
	}
	if err := os.WriteFile("/host-output/escaped", []byte("escaped"), 0o600); err == nil {
		fatal("worker reached the hidden host output mount")
	}
	fill, err := os.Create(outputRoot + "/fill.bin")
	if err != nil {
		fatal("worker cannot create scratch filler")
	}
	block := make([]byte, 4096)
	for err == nil {
		_, err = fill.Write(block)
	}
	_ = fill.Close()
	if !errors.Is(err, syscall.ENOSPC) {
		fatal("worker scratch did not reach ENOSPC")
	}
	if err := os.Remove(outputRoot + "/fill.bin"); err != nil {
		fatal("worker cannot remove scratch filler")
	}
	output := []byte("processed:" + string(input))
	if err := os.WriteFile(outputRoot+"/result.txt", output, 0o600); err != nil {
		fatal("worker cannot write artifact")
	}
	respond(encoder, invoke.ID, map[string]any{
		"invocation_id": invoke.Params["invocation_id"],
		"operation_id":  invoke.Params["operation_id"],
		"status":        "succeeded",
		"output": map[string]any{
			"access_isolated": true,
			"scratch_enospc":  true,
		},
		"artifacts": []map[string]any{{
			"path":       "/output/result.txt",
			"media_type": "text/plain",
			"name":       "result.txt",
		}},
	})
	shutdown := read(decoder, "shutdown", 3)
	respond(encoder, shutdown.ID, map[string]any{})
}

func read(decoder *json.Decoder, method string, id int) request {
	var value request
	if err := decoder.Decode(&value); err != nil || value.JSONRPC != "2.0" ||
		value.ID != id || value.Method != method {
		fatal("worker request changed")
	}
	return value
}

func respond(encoder *json.Encoder, id int, result map[string]any) {
	if err := encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result}); err != nil {
		fatal("worker response failed")
	}
}

func probeDescendantIsolation(params map[string]any) {
	probes, ok := params["host_probes"].(map[string]any)
	if !ok {
		fatal("descendant host isolation probes are missing")
	}
	hostPID, ok := probes["host_pid"].(float64)
	if !ok {
		fatal("descendant host PID probe is invalid")
	}
	child := exec.Command(os.Args[0])
	child.Env = append(
		os.Environ(),
		"SHEJANE_ESCAPE_CHILD=1",
		"SHEJANE_ESCAPE_SECRET_PATH="+probeString(probes, "secret_path"),
		"SHEJANE_ESCAPE_CREDENTIAL_PATH="+probeString(probes, "credential_path"),
		"SHEJANE_ESCAPE_UNIX_SOCKET_PATH="+probeString(probes, "unix_socket_path"),
		"SHEJANE_ESCAPE_TCP_ADDRESS="+probeString(probes, "tcp_address"),
		"SHEJANE_ESCAPE_HOST_PID="+strconv.Itoa(int(hostPID)),
	)
	if output, err := child.CombinedOutput(); err != nil {
		fatal("descendant escaped isolation: " + strings.TrimSpace(string(output)))
	}
}

func probeHostIsolation(params map[string]any) map[string]any {
	probes, ok := params["host_probes"].(map[string]any)
	if !ok {
		fatal("host isolation probes are missing")
	}
	secretPath := probeString(probes, "secret_path")
	credentialPath := probeString(probes, "credential_path")
	unixSocketPath := probeString(probes, "unix_socket_path")
	tcpAddress := probeString(probes, "tcp_address")
	hostPIDValue, ok := probes["host_pid"].(float64)
	if !ok || hostPIDValue < 2 || hostPIDValue != float64(int(hostPIDValue)) {
		fatal("host PID probe is invalid")
	}

	if _, err := os.ReadFile(secretPath); err == nil {
		fatal("worker read a host-only file")
	}
	if _, err := os.ReadFile(credentialPath); err == nil {
		fatal("worker read a host-only credential")
	}
	if process, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", int(hostPIDValue))); err == nil {
		if os.Getenv("SHEJANE_PLUGIN_LINUX_NATIVE") != "1" {
			fatal("worker observed a host process")
		}
		expected, decodeErr := base64.StdEncoding.DecodeString(
			probeString(probes, "host_process_cmdline"),
		)
		if decodeErr != nil || bytes.Equal(process, expected) {
			fatal("worker observed the host process identity")
		}
	}
	if connection, err := net.DialTimeout("unix", unixSocketPath, 250*time.Millisecond); err == nil {
		_ = connection.Close()
		fatal("worker reached a host Unix socket")
	}
	if connection, err := net.DialTimeout("tcp", tcpAddress, 250*time.Millisecond); err == nil {
		_ = connection.Close()
		fatal("worker reached host loopback")
	}
	interfaces, err := net.Interfaces()
	if err != nil && os.Getenv("SHEJANE_PLUGIN_LINUX_NATIVE") != "1" {
		fatal("worker cannot inspect guest network interfaces")
	}
	for _, networkInterface := range interfaces {
		if networkInterface.Flags&net.FlagUp != 0 && networkInterface.Flags&net.FlagLoopback == 0 {
			fatal("worker has a non-loopback network interface")
		}
	}
	if connection, err := net.DialTimeout("tcp", "192.0.2.1:9", 250*time.Millisecond); err == nil {
		_ = connection.Close()
		fatal("worker reached an external network")
	}
	return map[string]any{
		"external_network_isolated": true,
		"host_credentials_isolated": true,
		"host_files_isolated":       true,
		"host_processes_isolated":   true,
		"host_tcp_isolated":         true,
		"host_unix_socket_isolated": true,
	}
}

func probeString(probes map[string]any, name string) string {
	value, ok := probes[name].(string)
	if !ok || value == "" {
		fatal("host isolation probe is invalid")
	}
	return value
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
