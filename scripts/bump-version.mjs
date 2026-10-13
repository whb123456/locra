// 升版本号：同步 package.json / package-lock.json / README 里的产物文件名，提交并打 tag
// 用法：node scripts/bump-version.mjs <patch|minor|major>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const type = process.argv[2];
if (!['patch', 'minor', 'major'].includes(type)) {
  console.error('用法：npm run bump:<patch|minor|major>');
  process.exit(1);
}

const read = (file) => readFileSync(file, 'utf8');
const before = JSON.parse(read('package.json')).version;

// 交给 npm 改，避免手写 lockfile 的版本字段改漏
execFileSync('npm', ['version', type, '--no-git-tag-version'], { stdio: 'inherit' });
const after = JSON.parse(read('package.json')).version;

// README 里写死了 Locra-x.y.z-arm64.dmg / -x64.exe，不同步就会指向旧包
const readme = read('README.md');
const synced = readme.replaceAll(before, after);
if (synced !== readme) writeFileSync('README.md', synced);

execFileSync('git', ['add', 'package.json', 'package-lock.json', 'README.md']);
execFileSync('git', ['commit', '-m', `chore: 版本号升至 v${after}`], { stdio: 'inherit' });
// 打成 annotated tag，这样 git push --follow-tags 才会带上它
execFileSync('git', ['tag', '-a', `v${after}`, '-m', `v${after}`]);

console.log(`\n版本号 ${before} → ${after}，已提交并打 tag v${after}`);
console.log(`接着跑：npm run release:mac（打包 + 推送 tag）`);
