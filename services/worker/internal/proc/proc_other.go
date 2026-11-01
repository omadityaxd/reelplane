//go:build !windows && !linux

package proc

import "os/exec"

// Other platforms (macOS, BSD) rely on context cancellation only; the worker image is Linux.
func configure(*exec.Cmd) {}

func attach(*exec.Cmd) error { return nil }
