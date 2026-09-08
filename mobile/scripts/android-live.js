const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const candidates = [
  process.env.JAVA_HOME,
  'C:\\Program Files\\Android\\Android Studio1\\jbr',
  'C:\\Program Files\\Android\\Android Studio\\jbr',
].filter(Boolean);

function usable(home) {
  return (
    fs.existsSync(path.join(home, 'bin', 'java.exe')) &&
    fs.existsSync(path.join(home, 'lib', 'jvm.cfg'))
  );
}

const home = candidates.find(usable);
if (!home) {
  console.error(
    'No hay un JDK usable. Abre Android Studio una vez (File → Settings → Build → Gradle JDK) o instala un JDK 17+.',
  );
  process.exit(1);
}

process.env.JAVA_HOME = home;
process.env.PATH = path.join(home, 'bin') + path.delimiter + process.env.PATH;
console.log('JAVA_HOME=' + home);

const child = spawn(
  'npx',
  ['cap', 'run', 'android', '--live-reload', '--host', '10.0.2.2', '--port', '4200', '--forwardPorts', '4200:4200'],
  { stdio: 'inherit', shell: true, env: process.env },
);
child.on('exit', (code) => process.exit(code ?? 1));
