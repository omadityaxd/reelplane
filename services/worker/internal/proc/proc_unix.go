//go:build linux

package proc

import (
	"os/exec"
	"syscall"
)

// configure asks the kernel to SIGKILL the child when the worker dies. Caveat: Pdeathsig
// fires when the starting OS *thread* exits; Go only exits threads for goroutines that called
// LockOSThread, which the worker never does, so in practice this tracks the process.
func configure(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

func attach(*exec.Cmd) error { return nil }
