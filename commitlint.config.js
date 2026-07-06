// Enforce Conventional Commits (feat:, fix:, chore:, docs:, refactor:, etc.).
// release-please reads these commit types to decide the next version + changelog.
module.exports = {
  extends: ['@commitlint/config-conventional'],
};
