// Package proc runs child processes (FFmpeg) so that they never outlive the worker.
//
// When the worker is killed hard (OOM killer, `docker kill`, the chaos test), its children
// would normally keep running as orphans: still burning CPU, still writing files. On Linux
// each child gets PR_SET_PDEATHSIG=SIGKILL; on Windows every child joins a Job Object that is
// killed when the worker's last handle to it closes, i.e. when the worker dies.
package proc

import (
	"context"
	"os/exec"
	"time"
)

// waitDelay bounds how long Wait blocks on output pipes after the process was killed.
const waitDelay = 5 * time.Second

// Command is exec.CommandContext with lifetime protection: the child dies with the worker,
// and is killed when ctx is cancelled.
func Command(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = waitDelay
	configure(cmd)
	return cmd
}

// Start starts the command and binds it to the worker's lifetime.
func Start(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := attach(cmd); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	return nil
}

// Run starts the command and waits for it.
func Run(cmd *exec.Cmd) error {
	if err := Start(cmd); err != nil {
		return err
	}
	return cmd.Wait()
}

// Output runs the command and returns its stdout.
func Output(cmd *exec.Cmd) ([]byte, error) {
	var stdout limitedBuffer
	cmd.Stdout = &stdout
	if err := Run(cmd); err != nil {
		return nil, err
	}
	return stdout.Bytes(), nil
}

type limitedBuffer struct{ data []byte }

const maxOutput = 4 << 20

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := maxOutput - len(b.data); room > 0 {
		b.data = append(b.data, p[:min(len(p), room)]...)
	}
	return len(p), nil
}

func (b *limitedBuffer) Bytes() []byte { return b.data }
