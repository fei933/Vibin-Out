#!/usr/bin/env node
/**
 * The same Express app, served over HTTPS on localhost.
 *
 *   npm run dev:https        → https://localhost:3000
 *
 * Why this exists: Spotify stopped accepting `http://` redirect URIs, so the
 * PKCE export cannot be exercised locally over the ordinary dev server. The
 * app's registered redirect URIs are
 *
 *   https://vibin-out.vercel.app/callback
 *   https://localhost:3000/callback
 *
 * and the browser computes its own from `window.location.origin`, so the port
 * has to be 3000 for a real round trip. PORT is still respected — anything
 * else just won't match what Spotify has on file.
 *
 * The certificate is self-signed and made on first run. It is a development
 * certificate for one hostname on one machine: the browser will object once,
 * and that objection is correct. If you would rather not see it, run
 * `mkcert localhost 127.0.0.1` in certs/ and name the output localhost.key /
 * localhost.crt — this script uses whatever is already there.
 *
 * certs/ is git-ignored. Nothing in it should ever leave this machine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = path.join(ROOT, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'localhost.key');
const CRT_FILE = path.join(CERT_DIR, 'localhost.crt');

/**
 * 825 days is the maximum lifetime browsers accept for a server certificate
 * (CA/Browser Forum ballot SC22); anything longer is rejected outright by
 * Safari and Chrome, self-signed or not.
 */
const DAYS = 825;

/**
 * A config file rather than `-addext`, which LibreSSL — the `openssl` macOS
 * ships in /usr/bin — does not support. This form works on both.
 */
const OPENSSL_CONFIG = `
[req]
default_bits       = 2048
default_md         = sha256
prompt             = no
distinguished_name = dn
x509_extensions    = v3_ext

[dn]
CN = localhost

[v3_ext]
basicConstraints = critical, CA:FALSE
keyUsage         = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName   = @alt

[alt]
DNS.1 = localhost
IP.1  = 127.0.0.1
`;

function generate() {
  mkdirSync(CERT_DIR, { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vibin-cert-'));
  const configFile = path.join(tmp, 'openssl.cnf');
  writeFileSync(configFile, OPENSSL_CONFIG);
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-days',
        String(DAYS),
        '-nodes', // no passphrase: a dev server cannot answer a prompt
        '-keyout',
        KEY_FILE,
        '-out',
        CRT_FILE,
        '-config',
        configFile,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch (error) {
    console.error('\n[dev:https] could not generate a certificate with openssl.\n');
    console.error(String(error.stderr || error.message).trim());
    console.error(
      '\nInstall openssl, or put your own localhost.key / localhost.crt in certs/ ' +
        '(e.g. `mkcert localhost 127.0.0.1`) and run this again.\n',
    );
    process.exit(1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return true;
}

const hadCerts = existsSync(KEY_FILE) && existsSync(CRT_FILE);
if (!hadCerts) generate();

// Imported after the certificate work so a cert failure never spends time
// booting the app (app.js loads .env on import).
const { default: app } = await import('../app.js');

const port = Number(process.env.PORT) || 3000;

const server = https.createServer(
  { key: readFileSync(KEY_FILE), cert: readFileSync(CRT_FILE) },
  app,
);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n[dev:https] port ${port} is already in use — stop the other server first.\n`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, () => {
  console.log(`\nvibin' out (https) → https://localhost:${port}`);
  if (!hadCerts) {
    console.log(
      `made a self-signed certificate in certs/ — your browser will warn about it once; proceed anyway.`,
    );
  }
  console.log(`spotify already has https://localhost:${port}/callback on file as a redirect URI.\n`);
});
