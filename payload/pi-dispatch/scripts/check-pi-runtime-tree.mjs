// Reinstallation may replace only previously verified WSL dependency trees.
// Unknown or customized trees must be reconciled without deleting their files.
import {sdkTreeDigest,PI_151_TREE_SHA256} from './sdk-tree-integrity.mjs';
const previous='f71e24f4437ee02437bd64c6be9d3b44be3e720e2f10e97ec03d2427a17a4dd5';
if(process.argv.length!==3)throw Error('Expected the existing WSL Pi node_modules path');
const digest=sdkTreeDigest(process.argv[2]);
if(![previous,PI_151_TREE_SHA256].includes(digest))throw Error('Existing WSL Pi dependency tree is unrecognized; preserve it and reconcile before reinstalling');
console.log('Existing WSL Pi dependency tree is verified.');
