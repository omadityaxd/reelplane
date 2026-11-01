// Fails if any Go file in services/worker is not gofmt-formatted (cross-platform `test -z`).
import { execFileSync } from "node:child_process";

const unformatted = execFileSync("gofmt", ["-l", "."], {
  cwd: "services/worker",
  encoding: "utf8",
}).trim();
if (unformatted) {
  process.stderr.write(`Not gofmt-formatted (run \`gofmt -w services/worker\`):\n${unformatted}\n`);
  process.exit(1);
}
