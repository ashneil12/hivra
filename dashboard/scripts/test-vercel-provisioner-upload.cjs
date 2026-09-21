// Vercel CLI adds its default ignores before the project .vercelignore.
// Keep the immutable provisioner dotfile without reopening unrelated dotfiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ignore = require('ignore');
const rules = fs.readFileSync(path.join(__dirname,'../../.vercelignore'),'utf8');
const filter = ignore().add('.gitignore\n.git\n.vercel\n.env.local\n.env.*.local\nnode_modules\n'+rules);
assert.equal(filter.ignores('dashboard/provisioner/.gitignore'),false);
for(const file of ['.gitignore','dashboard/.gitignore','dashboard/other/.gitignore',
  'dashboard/.env.local','dashboard/.env.production.local','dashboard/node_modules/example/index.js',
  '.git/config','.vercel/project.json'])assert.equal(filter.ignores(file),true,file);
console.log('PASS Vercel upload: required bundle dotfile included, unrelated default exclusions retained');
