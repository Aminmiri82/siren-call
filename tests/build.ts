import { execFileSync } from 'node:child_process';

export default function build() {
  execFileSync('pnpm', ['run', 'build'], { stdio: 'inherit' });
}
