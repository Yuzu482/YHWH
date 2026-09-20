// SPDX-License-Identifier: Apache-2.0
// Syntax evidence only: no project execution, configuration loading or type inference.
import TS from '@vscode/tree-sitter-wasm';
import {createRequire} from 'node:module';
import {dirname, join, extname} from 'node:path';
import {parentPort} from 'node:worker_threads';

import {LANGUAGES} from './code-graph-schema.mjs';
const grammarRoot = dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm'));
const ready = TS.Parser.init();
const grammars = new Map();
const field = (node, name) => node.childForFieldName(name);
const text = node => node?.text ?? '';
const label = node => {
  const value = text(node);
  // Persist names, not arbitrary source snippets, arguments, literals or docstrings.
  return value.length <= 256 && /^[\p{L}\p{N}_$.:<>\[\]?! -]+$/u.test(value) ? value : '<dynamic>';
};
function literal(node) {
  if (!node || !['string','string_literal'].includes(node.type)) return null;
  const value = node.text;
  return /^(['"])[^'"\\\r\n]{1,256}\1$/.test(value) ? value.slice(1,-1) : null;
}

export async function parseSource(path, source) {
  const language = LANGUAGES[extname(path)];
  if (!language) throw new Error('Unsupported code graph language');
  await ready;
  if (!grammars.has(language)) grammars.set(language, await TS.Language.load(join(grammarRoot, `tree-sitter-${language}.wasm`)));
  const parser = new TS.Parser();
  parser.setLanguage(grammars.get(language));
  let tree;
  try {
    tree = parser.parse(source);
    if (!tree || tree.rootNode.hasError) return {language,status:'parse-error',symbols:[],imports:[],mentions:[]};
    const symbols = [], imports = [], mentions = [], counts = new Map();
    const stack = [{node:tree.rootNode,parent:null,qualified:''}];
    let visited = 0;
    while (stack.length) {
      if (++visited > 150000 || symbols.length + imports.length + mentions.length > 12000) throw new Error('AST budget exceeded');
      let {node,parent,qualified} = stack.pop();
      let kind = null, nameNode = field(node,'name');
      if (['class_declaration','class','class_definition','abstract_class_declaration'].includes(node.type)) kind='class';
      else if (['function_declaration','function_definition','generator_function_declaration'].includes(node.type)) kind='function';
      else if (node.type === 'method_definition') kind='method';
      else if (['interface_declaration','type_alias_declaration','enum_declaration'].includes(node.type)) kind='type';
      else if (node.type === 'variable_declarator' && ['arrow_function','function_expression','generator_function'].includes(field(node,'value')?.type)) kind='function';
      if (kind && nameNode) {
        const name=label(nameNode), full=qualified ? `${qualified}.${name}` : name;
        const key=`${kind}:${full}`, ordinal=counts.get(key) ?? 0; counts.set(key,ordinal+1);
        const id=`${path}#${key}:${ordinal}`;
        if (id.length > 1024) throw new Error('Symbol nesting budget exceeded');
        symbols.push({id,name,qualified:full,kind,parent,line:node.startPosition.row+1,endLine:node.endPosition.row+1});
        parent=id; qualified=full;
      }
      const line = node.startPosition.row+1;
      const addImport=(specifier,form) => {
        if (specifier && specifier.length <= 256 && !/[\x00-\x1f\x7f]/.test(specifier)) imports.push({specifier,form,line});
      };
      if (['import_statement','export_statement'].includes(node.type) && language !== 'python') addImport(literal(field(node,'source')),node.type);
      if (node.type === 'call_expression') {
        const callee=field(node,'function');
        if (['require','import'].includes(text(callee))) addImport(literal(field(node,'arguments')?.namedChildren[0]),text(callee));
        mentions.push({from:parent,kind:'call',name:label(callee),line});
      } else if (node.type === 'new_expression') mentions.push({from:parent,kind:'construct',name:label(field(node,'constructor')),line});
      else if (node.type === 'call') mentions.push({from:parent,kind:'call',name:label(field(node,'function')),line});
      if (language === 'python') {
        if (node.type === 'import_from_statement') addImport(text(field(node,'module_name')),'from');
        if (node.type === 'import_statement') for (const child of node.namedChildren) addImport(text(child.type === 'aliased_import' ? field(child,'name') : child),'import');
        if (node.type === 'class_definition') for (const base of field(node,'superclasses')?.namedChildren ?? []) mentions.push({from:parent,kind:'base',name:label(base),line});
      } else if (['extends_clause','implements_clause','class_heritage'].includes(node.type)) {
        for (const base of node.namedChildren) if (!['extends_clause','implements_clause'].includes(base.type)) mentions.push({from:parent,kind:'base',name:label(base),line});
      }
      // A nested anonymous function has no invented identity; calls retain the enclosing declaration.
      for (let i=node.namedChildCount-1;i>=0;i--) stack.push({node:node.namedChild(i),parent,qualified});
    }
    return {language,status:'parsed',symbols,imports,mentions};
  } finally { tree?.delete(); parser.delete(); }
}

if (parentPort) parentPort.on('message', async ({id,path,source}) => {
  try { parentPort.postMessage({id,result:await parseSource(path,source)}); }
  catch { parentPort.postMessage({id,error:'Source parsing failed or exceeded its budget'}); }
});
