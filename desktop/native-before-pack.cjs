const { target } = require('./native-helper.cjs');
exports.default = async context => { if (context.electronPlatformName !== 'darwin') target(context); };
