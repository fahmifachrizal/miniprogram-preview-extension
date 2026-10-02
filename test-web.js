const { spawn } = require('child_process');
const p = spawn('npx', ['minidev', 'dev', '--project', '../integration-test']);
p.stdout.on('data', (data) => {
  const str = data.toString();
  console.log(str);
  if (str.includes('可以继续执行以下命令')) {
    p.stdin.write('web\n');
  }
});
p.stderr.on('data', (data) => {
  console.error(data.toString());
});
