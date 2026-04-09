const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function stagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    return [];
  }
}

const patterns = [
  { name: 'private-key', re: /-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----/i },
  { name: 'rsa-private-key', re: /-----BEGIN RSA PRIVATE KEY-----/i },
  { name: 'openssh-private-key', re: /-----BEGIN OPENSSH PRIVATE KEY-----/i },
  { name: 'service-account-json', re: /"type"\s*:\s*"service_account"/i },
  { name: 'private_key_field', re: /"private_key"\s*:\s*"-----BEGIN/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'env-password', re: /(PASSWORD|SECRET|TOKEN|KEY)\s*=\s*/i }
];

function scanFile(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    for (const p of patterns) {
      if (p.re.test(content)) return { file: filepath, match: p.name };
    }
  } catch (e) {}
  return null;
}

function main() {
  const files = stagedFiles();
  const cwd = process.cwd();
  const findings = [];
  for (const f of files) {
    // Skip large/binary
    const p = path.join(cwd, f);
    if (!fs.existsSync(p)) continue;
    const stat = fs.statSync(p);
    if (stat.size > 1024 * 1024 * 5) continue; // skip >5MB
    const r = scanFile(p);
    if (r) findings.push(r);
  }

  if (findings.length > 0) {
    console.error('\n✗ Potential secrets detected in staged files:');
    for (const f of findings) console.error(` - ${f.file}  (pattern: ${f.match})`);
    console.error('\nPlease remove secrets from the staged changes and use environment variables or a secret store.');
    console.error('If these are false positives, adjust scripts/check-secrets.js patterns.');
    process.exit(1);
  }
  process.exit(0);
}

main();
