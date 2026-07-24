import { scryptSync, randomBytes } from 'node:crypto';
import readline from 'node:readline';

function askPasswordHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const stdin = process.stdin;
    process.stdout.write(query);

    const onData = (char) => {
      char = char.toString('utf8');
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.removeListener('data', onData);
          break;
        default:
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(query + '*'.repeat(rl.line.length));
          break;
      }
    };

    if (stdin.isTTY) {
      stdin.on('data', onData);
    }

    rl.question('', (answer) => {
      rl.close();
      if (stdin.isTTY) {
        stdin.removeListener('data', onData);
      }
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  console.log('--- Admin Password Hasher (scrypt) ---');
  const password = await askPasswordHidden('Enter admin password: ');
  if (!password || password.trim().length < 8) {
    console.error('ERROR: Password must be at least 8 characters long.');
    process.exit(1);
  }

  const salt = randomBytes(16);
  const cost = 16384;
  const blockSize = 8;
  const parallelization = 1;
  const keyLen = 32;

  const derivedKey = scryptSync(password, salt, keyLen, {
    N: cost,
    r: blockSize,
    p: parallelization,
  });

  const formattedHash = `scrypt:${cost}:${blockSize}:${parallelization}:${salt.toString('hex')}:${derivedKey.toString('hex')}`;

  console.log('\nGenerated ADMIN_PASSWORD_HASH:');
  console.log(formattedHash);
  console.log('\nCopy the line above into your environment variables as ADMIN_PASSWORD_HASH.');
}

main();
