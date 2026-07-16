//go:build linux

// shejane-managed-worker-linux starts one command atomically inside a bounded
// delegated cgroup v2 leaf and removes that leaf after the full process tree exits.
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	prSetPdeathsig = 1
	prSetDumpable  = 4
	prSetNoNewPriv = 38
	prSetSeccomp   = 22
	seccompFilter  = 2
)

type repeatedFlag []string

func (values *repeatedFlag) String() string { return strings.Join(*values, ",") }
func (values *repeatedFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func main() {
	if err := run(); err != nil {
		var childExit *childExitError
		if errors.As(err, &childExit) {
			os.Exit(childExit.code)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(125)
	}
}

type childExitError struct {
	code int
}

func (err *childExitError) Error() string {
	return fmt.Sprintf("managed worker exited with status %d", err.code)
}

func run() error {
	broker := flag.Bool("broker", false, "run the trusted in-namespace artifact broker")
	root := flag.String("cgroup-root", "", "delegated cgroup v2 root")
	memory := flag.Uint64("memory-bytes", 0, "hard memory limit")
	pids := flag.Uint64("pids-max", 0, "process and thread limit")
	cpu := flag.String("cpu-max", "", "cgroup v2 cpu.max value")
	bubblewrap := flag.String("bubblewrap", "", "verified bubblewrap executable")
	packageRoot := flag.String("package-root", "", "read-only plugin package root")
	inputRoot := flag.String("input-root", "", "read-only invocation input root")
	outputRoot := flag.String("output-root", "", "host artifact destination root")
	scratchBytes := flag.Uint64("scratch-bytes", 0, "private scratch tmpfs limit")
	outputBytes := flag.Uint64("output-bytes", 0, "declared artifact byte limit")
	maxFrameBytes := flag.Uint64("max-frame-bytes", 0, "maximum Worker protocol frame")
	var runtimeAssets repeatedFlag
	flag.Var(&runtimeAssets, "runtime-asset", "runtime asset id=absolute-path")
	flag.Parse()
	command := flag.Args()
	if len(command) == 0 {
		return errors.New("managed worker command is required after --")
	}
	if *broker {
		return runBroker(command, *scratchBytes, *outputBytes, *maxFrameBytes)
	}
	if *root == "" || *memory == 0 || *pids == 0 || *cpu == "" {
		return errors.New("managed worker cgroup limits are required")
	}
	if err := setParentDeathSignal(); err != nil {
		return fmt.Errorf("configure parent-death cleanup: %w", err)
	}
	if err := reapStaleLeaves(*root); err != nil {
		return err
	}
	leaf, err := createLeaf(*root, *memory, *pids, *cpu)
	if err != nil {
		return err
	}
	cleanupNeeded := true
	defer func() {
		if cleanupNeeded {
			_ = cleanupLeaf(leaf)
		}
	}()

	leafFD, err := os.Open(leaf)
	if err != nil {
		return fmt.Errorf("open managed worker cgroup: %w", err)
	}
	child := exec.Command(command[0], command[1:]...)
	var hostOutput *os.File
	if *bubblewrap != "" {
		child, hostOutput, err = sandboxedCommand(sandboxOptions{
			bubblewrap:    *bubblewrap,
			packageRoot:   *packageRoot,
			inputRoot:     *inputRoot,
			outputRoot:    *outputRoot,
			scratchBytes:  *scratchBytes,
			outputBytes:   *outputBytes,
			maxFrameBytes: *maxFrameBytes,
			runtimeAssets: runtimeAssets,
			command:       command,
		})
		if err != nil {
			_ = leafFD.Close()
			return err
		}
	}
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	child.Env = os.Environ()
	child.SysProcAttr = &syscall.SysProcAttr{
		Pdeathsig:   syscall.SIGKILL,
		Setpgid:     true,
		UseCgroupFD: true,
		CgroupFD:    int(leafFD.Fd()),
	}
	if err := child.Start(); err != nil {
		_ = leafFD.Close()
		if hostOutput != nil {
			_ = hostOutput.Close()
		}
		return fmt.Errorf("start managed worker in cgroup: %w", err)
	}
	_ = leafFD.Close()
	if hostOutput != nil {
		_ = hostOutput.Close()
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	done := make(chan struct{})
	go func() {
		select {
		case <-signals:
			_ = writeFile(leaf, "cgroup.kill", "1")
		case <-done:
		}
	}()
	waitErr := child.Wait()
	close(done)
	signal.Stop(signals)
	if err := cleanupLeaf(leaf); err != nil {
		return err
	}
	cleanupNeeded = false
	if waitErr == nil {
		return nil
	}
	var exit *exec.ExitError
	if errors.As(waitErr, &exit) {
		status, ok := exit.Sys().(syscall.WaitStatus)
		if ok && status.Signaled() {
			return &childExitError{code: 128 + int(status.Signal())}
		}
		return &childExitError{code: exit.ExitCode()}
	}
	return waitErr
}

type sandboxOptions struct {
	bubblewrap    string
	packageRoot   string
	inputRoot     string
	outputRoot    string
	scratchBytes  uint64
	outputBytes   uint64
	maxFrameBytes uint64
	runtimeAssets []string
	command       []string
}

func sandboxedCommand(options sandboxOptions) (*exec.Cmd, *os.File, error) {
	if options.scratchBytes == 0 || options.outputBytes == 0 || options.maxFrameBytes == 0 {
		return nil, nil, errors.New("managed worker sandbox limits are required")
	}
	bubblewrap, err := regularExecutable(options.bubblewrap)
	if err != nil {
		return nil, nil, fmt.Errorf("verify bubblewrap: %w", err)
	}
	packageRoot, err := resolvedDirectory(options.packageRoot)
	if err != nil {
		return nil, nil, fmt.Errorf("verify package root: %w", err)
	}
	inputRoot, err := resolvedDirectory(options.inputRoot)
	if err != nil {
		return nil, nil, fmt.Errorf("verify input root: %w", err)
	}
	outputRoot, err := resolvedDirectory(options.outputRoot)
	if err != nil {
		return nil, nil, fmt.Errorf("verify output root: %w", err)
	}
	if rootsOverlap(packageRoot, inputRoot) || rootsOverlap(packageRoot, outputRoot) ||
		rootsOverlap(inputRoot, outputRoot) {
		return nil, nil, errors.New("managed worker sandbox roots overlap")
	}
	entrypoint, err := filepath.EvalSymlinks(options.command[0])
	if err != nil {
		return nil, nil, fmt.Errorf("resolve managed worker entrypoint: %w", err)
	}
	relativeEntrypoint, err := filepath.Rel(packageRoot, entrypoint)
	if err != nil || relativeEntrypoint == "." || relativeEntrypoint == ".." ||
		strings.HasPrefix(relativeEntrypoint, ".."+string(filepath.Separator)) {
		return nil, nil, errors.New("managed worker entrypoint is outside the package")
	}
	assets, virtualAssets, err := parseRuntimeAssets(options.runtimeAssets)
	if err != nil {
		return nil, nil, err
	}
	self, err := filepath.EvalSymlinks("/proc/self/exe")
	if err != nil {
		return nil, nil, fmt.Errorf("resolve Linux sandbox launcher: %w", err)
	}
	outputFD, err := syscall.Open(
		outputRoot,
		syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
		0,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("open host artifact root: %w", err)
	}
	hostOutput := os.NewFile(uintptr(outputFD), "host-artifact-root")
	args := []string{
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
		"--clearenv",
		"--hostname", "shejane-worker",
		"--dir", "/etc",
		"--dir", "/tmp",
		"--dir", "/output",
		"--dir", "/runtime-assets",
		"--ro-bind", self, "/shejane-launcher",
		"--ro-bind", packageRoot, "/package",
		"--ro-bind", inputRoot, "/input",
		"--bind-fd", "3", "/host-output",
	}
	for _, root := range []string{
		"/lib",
		"/lib64",
		"/usr/lib",
		"/usr/lib64",
		"/usr/share/locale",
		"/usr/share/zoneinfo",
		"/etc/ld.so.cache",
		"/etc/localtime",
	} {
		if _, err := os.Stat(root); err == nil {
			args = append(args, "--ro-bind", root, root)
		}
	}
	for _, asset := range assets {
		args = append(args, "--ro-bind", asset.path, "/runtime-assets/"+asset.id)
	}
	args = append(
		args,
		"--proc", "/proc",
		"--dev", "/dev",
		"--remount-ro", "/",
		"--size", strconv.FormatUint(options.scratchBytes, 10),
		"--tmpfs", "/output",
		"--chdir", "/package",
		"--setenv", "HOME", "/tmp",
		"--setenv", "PATH", "",
		"--setenv", "PYTHONUTF8", "1",
		"--setenv", "SHEJANE_PLUGIN_INPUT_ROOT", "/input",
		"--setenv", "SHEJANE_PLUGIN_OUTPUT_ROOT", "/output",
		"--setenv", "SHEJANE_PLUGIN_ACCESS_ISOLATED", "1",
		"--setenv", "SHEJANE_PLUGIN_RESOURCE_ISOLATED", "1",
		"--setenv", "SHEJANE_PLUGIN_SANDBOXED", "1",
		"--setenv", "SHEJANE_PLUGIN_LINUX_NATIVE", "1",
		"--setenv", "SHEJANE_PLUGIN_RUNTIME_ASSETS", virtualAssets,
		"--",
		"/shejane-launcher",
		"--broker",
		"--scratch-bytes", strconv.FormatUint(options.scratchBytes, 10),
		"--output-bytes", strconv.FormatUint(options.outputBytes, 10),
		"--max-frame-bytes", strconv.FormatUint(options.maxFrameBytes, 10),
		"--",
		"/package/"+filepath.ToSlash(relativeEntrypoint),
	)
	args = append(args, options.command[1:]...)
	child := exec.Command(bubblewrap, args...)
	child.ExtraFiles = []*os.File{hostOutput}
	return child, hostOutput, nil
}

type runtimeAsset struct {
	id   string
	path string
}

func parseRuntimeAssets(values []string) ([]runtimeAsset, string, error) {
	assets := make([]runtimeAsset, 0, len(values))
	virtual := make(map[string]string, len(values))
	for _, value := range values {
		id, rawPath, ok := strings.Cut(value, "=")
		if !ok || id == "" || len(id) > 100 || strings.ContainsAny(id, "/\\\x00") {
			return nil, "", errors.New("managed worker runtime asset is invalid")
		}
		if _, exists := virtual[id]; exists {
			return nil, "", errors.New("managed worker runtime asset is duplicated")
		}
		path, err := resolvedDirectory(rawPath)
		if err != nil {
			return nil, "", fmt.Errorf("verify managed worker runtime asset: %w", err)
		}
		assets = append(assets, runtimeAsset{id: id, path: path})
		virtual[id] = "/runtime-assets/" + id
	}
	raw, err := json.Marshal(virtual)
	if err != nil {
		return nil, "", err
	}
	return assets, string(raw), nil
}

func regularExecutable(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("executable path must be absolute")
	}
	metadata, err := os.Lstat(path)
	if err != nil || !metadata.Mode().IsRegular() || metadata.Mode()&os.ModeSymlink != 0 ||
		metadata.Mode().Perm()&0o111 == 0 {
		return "", errors.New("executable is unavailable")
	}
	return path, nil
}

func resolvedDirectory(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("directory path must be absolute")
	}
	metadata, err := os.Lstat(path)
	if err != nil || !metadata.IsDir() || metadata.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("directory is unavailable")
	}
	return filepath.EvalSymlinks(path)
}

func rootsOverlap(first, second string) bool {
	return pathWithin(first, second) || pathWithin(second, first)
}

func pathWithin(parent, candidate string) bool {
	relative, err := filepath.Rel(parent, candidate)
	return err == nil && (relative == "." || relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func runBroker(command []string, scratchBytes, outputBytes, maxFrameBytes uint64) error {
	if scratchBytes == 0 || outputBytes == 0 || outputBytes > scratchBytes || maxFrameBytes == 0 {
		return errors.New("managed worker broker limits are invalid")
	}
	hostOutputFD, err := syscall.Open(
		"/host-output",
		syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
		0,
	)
	if err != nil {
		return fmt.Errorf("open host artifact transfer mount: %w", err)
	}
	hostOutput := os.NewFile(uintptr(hostOutputFD), "host-artifact-root")
	defer hostOutput.Close()
	metadata, err := hostOutput.Stat()
	if err != nil || !metadata.IsDir() {
		return errors.New("host artifact root descriptor is invalid")
	}
	if err := syscall.Unmount("/host-output", syscall.MNT_DETACH); err != nil {
		return fmt.Errorf("hide host artifact transfer mount: %w", err)
	}
	if err := configureScratch(scratchBytes); err != nil {
		return err
	}
	if err := setPrctl(prSetDumpable, 0); err != nil {
		return fmt.Errorf("protect Linux artifact broker: %w", err)
	}
	if err := dropCapabilities(); err != nil {
		return fmt.Errorf("drop Linux sandbox capabilities: %w", err)
	}
	if err := setPrctl(prSetNoNewPriv, 1); err != nil {
		return fmt.Errorf("set Linux no_new_privs: %w", err)
	}
	if err := installSeccomp(); err != nil {
		return fmt.Errorf("install Linux seccomp filter: %w", err)
	}
	child := exec.Command(command[0], command[1:]...)
	child.Stdin = os.Stdin
	stdout, err := child.StdoutPipe()
	if err != nil {
		return err
	}
	child.Stderr = os.Stderr
	child.Env = append(
		os.Environ(),
		"SHEJANE_PLUGIN_BROKER_PID="+strconv.Itoa(os.Getpid()),
		"SHEJANE_PLUGIN_BROKER_OUTPUT_FD="+strconv.Itoa(int(hostOutput.Fd())),
	)
	child.Dir = "/package"
	child.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL, Setpgid: true}
	if err := child.Start(); err != nil {
		return fmt.Errorf("start sandboxed managed worker: %w", err)
	}
	reader := bufio.NewReaderSize(stdout, int(maxFrameBytes)+1)
	for {
		frame, err := readFrame(reader, maxFrameBytes)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			_ = child.Process.Kill()
			_ = child.Wait()
			return err
		}
		if err := copyDeclaredArtifacts(frame, int(hostOutput.Fd()), outputBytes); err != nil {
			_ = child.Process.Kill()
			_ = child.Wait()
			return err
		}
		if _, err := os.Stdout.Write(frame); err != nil {
			_ = child.Process.Kill()
			_ = child.Wait()
			return err
		}
	}
	if err := child.Wait(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return &childExitError{code: exit.ExitCode()}
		}
		return err
	}
	return nil
}

func configureScratch(bytes uint64) error {
	options := fmt.Sprintf("size=%d,nr_inodes=%d", bytes, max(uint64(128), bytes/4096))
	flags := uintptr(syscall.MS_REMOUNT | syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC)
	if err := syscall.Mount("", "/output", "tmpfs", flags, options); err != nil {
		return fmt.Errorf("limit private output tmpfs: %w", err)
	}
	if err := os.Mkdir("/output/.tmp", 0o700); err != nil {
		return fmt.Errorf("create private temporary directory: %w", err)
	}
	if err := syscall.Mount("/output/.tmp", "/tmp", "", syscall.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind private temporary directory: %w", err)
	}
	if err := syscall.Mount(
		"",
		"/tmp",
		"",
		syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC,
		"",
	); err != nil {
		return fmt.Errorf("protect private temporary directory: %w", err)
	}
	return nil
}

type workerResponse struct {
	ID     int `json:"id"`
	Result *struct {
		Artifacts []struct {
			Path string `json:"path"`
		} `json:"artifacts"`
	} `json:"result"`
}

func readFrame(reader *bufio.Reader, limit uint64) ([]byte, error) {
	frame, err := reader.ReadBytes('\n')
	if err != nil {
		if errors.Is(err, io.EOF) && len(frame) == 0 {
			return nil, io.EOF
		}
		return nil, errors.New("managed worker emitted an incomplete frame")
	}
	if uint64(len(frame)) > limit {
		return nil, errors.New("managed worker frame limit exceeded")
	}
	return frame, nil
}

func copyDeclaredArtifacts(frame []byte, hostRoot int, outputBytes uint64) error {
	var response workerResponse
	if json.Unmarshal(frame, &response) != nil || response.ID != 2 || response.Result == nil ||
		len(response.Result.Artifacts) == 0 {
		return nil
	}
	if len(response.Result.Artifacts) > 256 {
		return errors.New("managed worker artifact count exceeded")
	}
	privateRoot, err := syscall.Open(
		"/output",
		syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
		0,
	)
	if err != nil {
		return fmt.Errorf("open private artifact root: %w", err)
	}
	defer syscall.Close(privateRoot)
	seen := map[string]bool{}
	var total uint64
	for _, artifact := range response.Result.Artifacts {
		relative, ok := strings.CutPrefix(artifact.Path, "/output/")
		if !ok || !validRelativePath(relative) || seen[relative] {
			return errors.New("managed worker artifact path is invalid")
		}
		seen[relative] = true
		parts := strings.Split(relative, "/")
		source, err := openArtifact(privateRoot, parts)
		if err != nil {
			return err
		}
		metadata, err := source.Stat()
		if err != nil || !metadata.Mode().IsRegular() || metadata.Size() < 0 ||
			uint64(metadata.Size()) > outputBytes-total {
			_ = source.Close()
			return errors.New("managed worker artifact output limit exceeded")
		}
		total += uint64(metadata.Size())
		destination, parent, name, err := createArtifact(hostRoot, parts)
		if err != nil {
			_ = source.Close()
			return err
		}
		_, copyErr := io.CopyN(destination, source, metadata.Size())
		if copyErr == nil {
			copyErr = destination.Sync()
		}
		_ = source.Close()
		_ = destination.Close()
		if copyErr != nil {
			_ = syscall.Unlinkat(parent, name)
			_ = syscall.Close(parent)
			return fmt.Errorf("copy managed worker artifact: %w", copyErr)
		}
		_ = syscall.Close(parent)
	}
	return nil
}

func validRelativePath(path string) bool {
	if path == "" || len(path) > 4096 || strings.ContainsAny(path, "\\\x00") {
		return false
	}
	parts := strings.Split(path, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return false
		}
	}
	return true
}

func openArtifact(root int, parts []string) (*os.File, error) {
	directory, err := syscall.Dup(root)
	if err != nil {
		return nil, err
	}
	for _, part := range parts[:len(parts)-1] {
		next, err := syscall.Openat(
			directory,
			part,
			syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
			0,
		)
		_ = syscall.Close(directory)
		if err != nil {
			return nil, errors.New("managed worker artifact path is unsafe")
		}
		directory = next
	}
	file, err := syscall.Openat(
		directory,
		parts[len(parts)-1],
		syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
		0,
	)
	_ = syscall.Close(directory)
	if err != nil {
		return nil, errors.New("managed worker artifact is unavailable")
	}
	return os.NewFile(uintptr(file), "private-artifact"), nil
}

func createArtifact(root int, parts []string) (*os.File, int, string, error) {
	directory, err := syscall.Dup(root)
	if err != nil {
		return nil, -1, "", err
	}
	for _, part := range parts[:len(parts)-1] {
		next, openErr := syscall.Openat(
			directory,
			part,
			syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
			0,
		)
		if errors.Is(openErr, syscall.ENOENT) {
			if mkdirErr := syscall.Mkdirat(directory, part, 0o700); mkdirErr != nil &&
				!errors.Is(mkdirErr, syscall.EEXIST) {
				_ = syscall.Close(directory)
				return nil, -1, "", errors.New("create host artifact directory failed")
			}
			next, openErr = syscall.Openat(
				directory,
				part,
				syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
				0,
			)
		}
		_ = syscall.Close(directory)
		if openErr != nil {
			return nil, -1, "", errors.New("host artifact directory is unsafe")
		}
		directory = next
	}
	name := parts[len(parts)-1]
	file, err := syscall.Openat(
		directory,
		name,
		syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC,
		0o600,
	)
	if err != nil {
		_ = syscall.Close(directory)
		return nil, -1, "", errors.New("host artifact destination is unsafe")
	}
	return os.NewFile(uintptr(file), "host-artifact"), directory, name, nil
}

type capHeader struct {
	version uint32
	pid     int32
}

type capData struct {
	effective   uint32
	permitted   uint32
	inheritable uint32
}

func dropCapabilities() error {
	header := capHeader{version: 0x20080522}
	data := [2]capData{}
	_, _, errno := syscall.RawSyscall(
		syscall.SYS_CAPSET,
		uintptr(unsafe.Pointer(&header)),
		uintptr(unsafe.Pointer(&data[0])),
		0,
	)
	return errnoError(errno)
}

type sockFilter struct {
	code uint16
	jt   uint8
	jf   uint8
	k    uint32
}

type sockFprog struct {
	length uint16
	filter *sockFilter
}

func installSeccomp() error {
	arch, clone, denied, err := seccompPolicy(runtime.GOARCH)
	if err != nil {
		return err
	}
	filters := []sockFilter{
		{code: 0x20, k: 4},
		{code: 0x15, jt: 1, k: arch},
		{code: 0x06, k: 0x80000000},
		{code: 0x20, k: 0},
		// A normal clone remains available for process creation, but creating a
		// nested user namespace would recover capabilities inside the sandbox.
		{code: 0x15, jf: 3, k: clone},
		{code: 0x20, k: 16},
		{code: 0x45, jf: 1, k: 0x10000000},
		{code: 0x06, k: 0x00050000 | uint32(syscall.EPERM)},
		{code: 0x20, k: 0},
	}
	for _, number := range denied {
		filters = append(filters,
			sockFilter{code: 0x15, jf: 1, k: number},
			sockFilter{code: 0x06, k: 0x00050000 | uint32(syscall.EPERM)},
		)
	}
	filters = append(filters, sockFilter{code: 0x06, k: 0x7fff0000})
	program := sockFprog{length: uint16(len(filters)), filter: &filters[0]}
	_, _, errno := syscall.Syscall6(
		syscall.SYS_PRCTL,
		prSetSeccomp,
		seccompFilter,
		uintptr(unsafe.Pointer(&program)),
		0,
		0,
		0,
	)
	return errnoError(errno)
}

func seccompPolicy(architecture string) (uint32, uint32, []uint32, error) {
	common := []uint32{425, 435, 438}
	switch architecture {
	case "arm64":
		return 0xc00000b7, 220, append(common, 40, 41, 51, 97, 117, 198, 199, 217, 218, 219, 241, 265, 268, 270, 271, 280), nil
	case "amd64":
		return 0xc000003e, 56, append(common, 41, 53, 101, 155, 161, 165, 248, 249, 250, 272, 298, 304, 308, 310, 311, 321), nil
	default:
		return 0, 0, nil, errors.New("Linux seccomp architecture is unsupported")
	}
}

func setPrctl(option, value uintptr) error {
	_, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, option, value, 0, 0, 0, 0)
	return errnoError(errno)
}

func errnoError(errno syscall.Errno) error {
	if errno != 0 {
		return errno
	}
	return nil
}

func setParentDeathSignal() error {
	parent := os.Getppid()
	_, _, errno := syscall.Syscall6(
		syscall.SYS_PRCTL,
		prSetPdeathsig,
		uintptr(syscall.SIGTERM),
		0,
		0,
		0,
		0,
	)
	if errno != 0 {
		return errno
	}
	if os.Getppid() != parent {
		return syscall.ESRCH
	}
	return nil
}

func createLeaf(root string, memory, pids uint64, cpu string) (string, error) {
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve delegated cgroup root: %w", err)
	}
	if !filepath.IsAbs(resolved) {
		return "", errors.New("delegated cgroup root must be absolute")
	}
	controllers, err := os.ReadFile(filepath.Join(resolved, "cgroup.controllers"))
	if err != nil {
		return "", fmt.Errorf("read delegated cgroup controllers: %w", err)
	}
	for _, required := range []string{"cpu", "memory", "pids"} {
		if !containsField(controllers, required) {
			return "", fmt.Errorf("delegated cgroup controller is missing: %s", required)
		}
	}
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("create cgroup identity: %w", err)
	}
	leaf := filepath.Join(resolved, fmt.Sprintf("shejane-%d-%x", os.Getpid(), random))
	if err := os.Mkdir(leaf, 0o700); err != nil {
		return "", fmt.Errorf("create managed worker cgroup: %w", err)
	}
	configured := false
	defer func() {
		if !configured {
			_ = os.Remove(leaf)
		}
	}()
	values := [][2]string{
		{"memory.max", strconv.FormatUint(memory, 10)},
		{"memory.swap.max", "0"},
		{"memory.oom.group", "1"},
		{"pids.max", strconv.FormatUint(pids, 10)},
		{"cpu.max", cpu},
	}
	for _, value := range values {
		if err := writeFile(leaf, value[0], value[1]); err != nil {
			return "", err
		}
		actual, err := os.ReadFile(filepath.Join(leaf, value[0]))
		if err != nil || strings.TrimSpace(string(actual)) != value[1] {
			return "", fmt.Errorf("verify managed worker cgroup limit: %s", value[0])
		}
	}
	configured = true
	return leaf, nil
}

func reapStaleLeaves(root string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("read delegated cgroup root: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "shejane-") {
			continue
		}
		parts := strings.SplitN(strings.TrimPrefix(entry.Name(), "shejane-"), "-", 2)
		pid, err := strconv.Atoi(parts[0])
		if err != nil || pid <= 0 || len(parts) != 2 {
			continue
		}
		killErr := syscall.Kill(pid, 0)
		if killErr == nil || !errors.Is(killErr, syscall.ESRCH) {
			continue
		}
		leaf := filepath.Join(root, entry.Name())
		isPopulated, err := populated(leaf)
		if err != nil {
			return err
		}
		if isPopulated {
			_ = writeFile(leaf, "cgroup.kill", "1")
			_ = waitEmpty(leaf, time.Second)
		}
		_ = os.Remove(leaf)
	}
	return nil
}

func cleanupLeaf(leaf string) error {
	if err := writeFile(leaf, "cgroup.kill", "1"); err != nil {
		return err
	}
	if err := waitEmpty(leaf, 2*time.Second); err != nil {
		return err
	}
	if err := os.Remove(leaf); err != nil {
		return fmt.Errorf("remove managed worker cgroup: %w", err)
	}
	return nil
}

func waitEmpty(leaf string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	isPopulated, err := populated(leaf)
	if err != nil {
		return err
	}
	for isPopulated && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
		isPopulated, err = populated(leaf)
		if err != nil {
			return err
		}
	}
	if isPopulated {
		return errors.New("managed worker cgroup did not become empty")
	}
	return nil
}

func populated(leaf string) (bool, error) {
	raw, err := os.ReadFile(filepath.Join(leaf, "cgroup.events"))
	if err != nil {
		return false, fmt.Errorf("read managed worker cgroup events: %w", err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "populated 1" {
			return true, nil
		}
	}
	return false, nil
}

func writeFile(root, name, value string) error {
	if err := os.WriteFile(filepath.Join(root, name), []byte(value), 0o600); err != nil {
		return fmt.Errorf("write managed worker cgroup %s: %w", name, err)
	}
	return nil
}

func containsField(raw []byte, expected string) bool {
	for _, field := range strings.Fields(string(raw)) {
		if field == expected {
			return true
		}
	}
	return false
}
