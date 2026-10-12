import {createHash} from 'node:crypto';

// Host test preparation only, from frozen initial bytes, never worker paths.
// Pin parity with resolveCache's root manifest enumeration in the companion test.
const manifestName=/^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pyproject\.toml|requirements.*|Cargo\.(?:lock|toml)|go\.(?:mod|sum)|pom\.xml|build\.gradle|.*\.csproj|packages\.lock\.json)$/;
export function registeredProjectFiles(sources) {
  if(!sources||typeof sources!=='object'||Array.isArray(sources)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(sources))||
    Object.getOwnPropertySymbols(sources).length)throw Error('FROZEN_SOURCES_INVALID');
  const names=Object.keys(sources);
  if(names.length>4096)throw Error('FROZEN_SOURCES_LIMIT');
  for(const name of names)if(name.length>1024||/[\\:\x00-\x1f\x7f]/.test(name)||
    name.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('PROJECT_MANIFEST_PATH');
  const selected=names.filter(name=>!name.includes('/')&&manifestName.test(name)).sort();
  if(selected.length>16)throw Error('PROJECT_MANIFEST_LIMIT');
  return selected.map(name=>{
    if(!name||name.length>1024||/[\\:\x00-\x1f\x7f]/.test(name)||name==='.'||name==='..')throw Error('PROJECT_MANIFEST_PATH');
    const descriptor=Object.getOwnPropertyDescriptor(sources,name);
    if(!descriptor||!Object.hasOwn(descriptor,'value')||
      !(typeof descriptor.value==='string'||Buffer.isBuffer(descriptor.value)))throw Error('PROJECT_MANIFEST_BYTES');
    return{path:name,sha256:createHash('sha256').update(descriptor.value).digest('hex')};
  });
}
