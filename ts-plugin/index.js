const path = require('path');

// TypeScript server plugin: brings back `my.*` IntelliSense on TypeScript 6+.
// The alipay.minicode extension adds the mini program typings as an extra type root, but since
// TypeScript 6 `types` defaults to [] and type roots are no longer loaded on their own. For mini
// programs (app.json or mini.project.json) that don't set `types`, this sets it to ["*"], the old
// default, which minicode then extends with its typings.
function init({ typescript: ts }) {
  const major = Number(String(ts.versionMajorMinor || ts.version).split('.')[0]);
  return {
    create(info) {
      const project = info.project;
      if (major < 6) return info.languageService;
      const dir = project.getCurrentDirectory();
      const isMiniProgram = ['app.json', 'mini.project.json'].some((file) => project.fileExists(path.join(dir, file)));
      if (!isMiniProgram) return info.languageService;
      const getCompilationSettings = project.getCompilationSettings.bind(project);
      project.getCompilationSettings = () => {
        const options = getCompilationSettings();
        return Array.isArray(options.types) ? options : { ...options, types: ['*'] };
      };
      info.project.projectService.logger.info(`[miniprogram-ts-types] types: ["*"] for ${dir}`);
      return info.languageService;
    },
  };
}

module.exports = init;
