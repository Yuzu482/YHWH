import {z} from 'zod';
import {EditorBridge,registerEditor} from '../editor-common/runtime.mjs';
const name=z.string().min(1).max(128).regex(/^[^\x00-\x1f]+$/);
const vec=z.tuple([z.number().finite().min(-1000000).max(1000000),z.number().finite().min(-1000000).max(1000000),z.number().finite().min(-1000000).max(1000000)]);
const file=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/);
const id=z.string().regex(/^-?[0-9]{1,20}$/).refine(v=>BigInt(v)>=-2147483648n&&BigInt(v)<=18446744073709551615n);
export const operations={
 unity_scene_info:{access:'read',schema:z.object({}).strict()},
 unity_get_logs:{access:'read',schema:z.object({maxEntries:z.number().int().min(1).max(100).default(20)}).strict()},
 unity_create_object:{access:'write',schema:z.object({name,primitive:z.enum(['Cube','Sphere','Cylinder','Capsule','Plane','Quad'])}).strict()},
 unity_set_transform:{access:'write',schema:z.object({objectId:id,position:vec,rotation:vec,scale:vec}).strict()},
 unity_delete_object:{access:'write',schema:z.object({objectId:id}).strict()},
 unity_create_material:{access:'write',schema:z.object({fileName:file,color:z.tuple([z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1)])}).strict()},
 unity_save_prefab:{access:'write',schema:z.object({objectId:id,fileName:file}).strict()},
};
export function csString(value){return '@"'+value.replaceAll('"','""')+'"';}
const vector=v=>'new Vector3('+v.map(n=>String(n)+'f').join(',')+')';
export function compileOperation(tool,input,c){
 const op=operations[tool];if(!op)throw new Error('Unknown Unity operation');
 const expected=input?._piScene;
 if(expected!==undefined)z.object({name:z.string().min(1).max(256),path:z.string().max(4096)}).strict().parse(expected);
 const {_piScene,...plain}=input||{};
 const a=op.schema.parse(plain);
 if(tool==='unity_get_logs')return {tool:'Unity_GetConsoleLogs',args:{maxEntries:a.maxEntries,includeStackTrace:false}};
 const project=c.transport.cwd.replaceAll('\\','/').replace(/\/$/,'');
 const assetRoot=c.assetRoot||'Assets/PiGenerated';
 if(!/^Assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(assetRoot))throw new Error('Invalid Unity asset root');
 let body='';
 const target=()=>`var obj=FromId(${csString(a.objectId)});
 if(obj==null || EditorUtility.IsPersistent(obj) || obj.scene!=UnityEngine.SceneManagement.SceneManager.GetActiveScene()) throw new System.Exception("Expected an object in active scene");`;
 const assetPath=extension=>`string folder=${csString(assetRoot)};
 string absolute=System.IO.Path.GetFullPath(System.IO.Path.Combine(Application.dataPath,"..",folder));
 string cursor=absolute;
 while(!string.IsNullOrEmpty(cursor)){if(System.IO.Directory.Exists(cursor) && (System.IO.File.GetAttributes(cursor)&System.IO.FileAttributes.ReparsePoint)!=0) throw new System.Exception("Asset root reparse point rejected");cursor=System.IO.Path.GetDirectoryName(cursor);}
 string path=folder+"/"+${csString(a.fileName+extension)};
 string target=System.IO.Path.Combine(absolute,${csString(a.fileName+extension)});
 if(System.IO.File.Exists(target)||System.IO.File.Exists(target+".meta")||System.IO.Directory.Exists(target)||AssetDatabase.LoadMainAssetAtPath(path)!=null) throw new System.Exception("Asset already exists");
 string current="Assets";foreach(string part in folder.Substring(7).Split('/')){if(!AssetDatabase.IsValidFolder(current+"/"+part)) AssetDatabase.CreateFolder(current,part);current+="/"+part;}
`;
 if(tool==='unity_scene_info')body=`var scene=UnityEngine.SceneManagement.SceneManager.GetActiveScene();result.Log("Scene: "+scene.name+"; path: "+scene.path+"; version: "+Application.unityVersion);
 var roots=scene.GetRootGameObjects();result.Log("Root count: "+roots.Length);for(int i=0;i<System.Math.Min(roots.Length,100);i++)result.Log(ObjectId(roots[i])+": "+roots[i].name);`;
 if(tool==='unity_create_object')body=`var obj=GameObject.CreatePrimitive(PrimitiveType.${a.primitive});result.RegisterObjectCreation(obj);obj.name=${csString(a.name)};result.Log("Created objectId: "+ObjectId(obj));`;
 if(tool==='unity_set_transform')body=target()+`result.RegisterObjectModification(obj.transform);obj.transform.position=${vector(a.position)};obj.transform.eulerAngles=${vector(a.rotation)};obj.transform.localScale=${vector(a.scale)};EditorUtility.SetDirty(obj);UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(obj.scene);result.Log("Updated objectId: "+ObjectId(obj));`;
 if(tool==='unity_delete_object')body=target()+`result.DestroyObject(obj);result.Log("Deleted objectId: ${a.objectId}");`;
 if(tool==='unity_create_material')body=assetPath('.mat')+`var shader=Shader.Find("Universal Render Pipeline/Lit")??Shader.Find("Standard");if(shader==null)throw new System.Exception("No supported shader");var material=new Material(shader);material.color=new Color(${a.color.map(n=>n+'f').join(',')});AssetDatabase.CreateAsset(material,path);result.RegisterObjectCreation(material);AssetDatabase.SaveAssetIfDirty(material);result.Log("Created material: "+path);`;
 if(tool==='unity_save_prefab')body=target()+assetPath('.prefab')+`var saved=PrefabUtility.SaveAsPrefabAsset(obj,path);if(saved==null)throw new System.Exception("Prefab save failed");result.Log("Saved prefab: "+path);`;
 if(!body)throw new Error('Unknown operation');
 const guard=`if(!string.Equals(System.IO.Path.GetFullPath(Application.dataPath+"/..").Replace('\\\\','/').TrimEnd('/'),${csString(project)},System.StringComparison.OrdinalIgnoreCase))throw new System.Exception("Unity project mismatch");`;
 const sceneGuard=expected?`var expectedScene=UnityEngine.SceneManagement.SceneManager.GetActiveScene();if(expectedScene.name!=${csString(expected.name)} || expectedScene.path!=${csString(expected.path)})throw new System.Exception("Authorized Unity scene changed");`:'';
 const writeGuard=op.access==='write'?'if(EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling)throw new System.Exception("Editor busy or in Play Mode");'+sceneGuard:'';
 const compatibility=`
 static string ObjectId(GameObject obj){
 var getter=typeof(UnityEngine.Object).GetMethod("GetEntityId",System.Type.EmptyTypes)??typeof(UnityEngine.Object).GetMethod("GetInstanceID",System.Type.EmptyTypes);
 var value=getter.Invoke(obj,null);var convert=value.GetType().GetMethod("ToULong",new System.Type[]{value.GetType()});
 return (convert==null?value:convert.Invoke(null,new object[]{value})).ToString();
 }
 static GameObject FromId(string id){
 int count=0;foreach(var root in UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects())foreach(var t in root.GetComponentsInChildren<Transform>(true)){if(++count>20000)throw new System.Exception("Scene object search limit exceeded");if(ObjectId(t.gameObject)==id)return t.gameObject;}return null;
 }
`;
 return {tool:'Unity_RunCommand',args:{Title:'Pi '+tool,Code:`using UnityEngine;using UnityEditor;internal class CommandScript:IRunCommand{${compatibility}public void Execute(ExecutionResult result){${guard}${writeGuard}${body}}}`}};
}
export class UnityBridge extends EditorBridge{
 constructor(options){super('unity',options);}
 async request(c,action,{tool,args},signal){
  if(c.transport.type!=='stdio')throw new Error('Unity requires the existing native stdio relay');
  for(const [key,access] of Object.entries(c.tools))if(!operations[key]||operations[key].access!==access)throw new Error('Invalid Unity operation allowlist');
  const remote={...c,tools:{Unity_RunCommand:'write',Unity_GetConsoleLogs:'read'}};
  if(action==='tools')return {ok:true,editor:'unity',tools:Object.keys(c.tools).map(n=>({name:n,access:operations[n].access,inputSchema:z.toJSONSchema(operations[n].schema)}))};
  if(action==='status'){
   const r=await super.request(remote,'status',{},signal);
   return {...r,availableTools:Object.keys(c.tools).filter(n=>r.availableTools.includes(n==='unity_get_logs'?'Unity_GetConsoleLogs':'Unity_RunCommand')),missingRemoteTools:r.missingTools};
  }
  const call=compileOperation(tool,args,c);
  return {...await super.request(remote,'call',call,signal),operation:tool};
 }
}
export default function(pi){registerEditor(pi,'unity',UnityBridge);}
