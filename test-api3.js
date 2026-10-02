const { spawn } = require('child_process');
const p = spawn('npx', ['minidev', 'dev', '--project', '../integration-test']);
p.stdout.on('data', (d) => {
  const str = d.toString();
  console.log(str);
  if (str.includes('web : 启动 Web')) {
     p.stdin.write('web\n');
  }
});
p.stderr.on('data', d => console.error(d.toString()));
