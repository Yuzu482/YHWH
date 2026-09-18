import {createHash} from 'node:crypto';
import {sanitizeResult} from './result-export.js';

export const CONTRACT_VERSION = 2;
const aliases = {worker:'Chesed', researcher:'Malkuth', reviewer:'Geburah'};
export const canonicalRole = role => Object.hasOwn(aliases, role) ? aliases[role] : role;
const text = {type:'string', maxLength:262144};
const nonempty = {...text, minLength:1};
const strings = {type:'array', items:nonempty, maxItems:256};
const enumeration = values => ({type:'string', enum:values});
const object = properties => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const array = items => ({type:'array', items, maxItems:256});
const check = object({name:nonempty, outcome:enumeration(['passed','failed','unverified']), evidence:text});
const ROLES = ['Yesod','Binah','Hod','Malkuth','Chochmah','Chesed','Netzach','Geburah'];
const deliverables = {
  Yesod:object({goal:nonempty, scope:strings, constraints:strings, exclusions:strings, acceptance:strings}),
  Binah:object({clarificationNeeded:{type:'boolean'}, questions:strings, resolution:text}),
  Hod:object({complexity:enumeration(['low','medium','high']), risk:enumeration(['low','medium','high']), rationale:nonempty, dependencies:strings}),
  Malkuth:object({observations:strings, sources:strings, limitations:strings}),
  Chochmah:object({steps:array(object({id:nonempty, role:enumeration(ROLES), objective:nonempty, readScope:strings, writeScope:strings, dependsOn:strings, acceptance:strings})), verification:strings}),
  Chesed:object({summary:nonempty, changes:strings, checks:array(check)}),
  Netzach:object({verdict:enumeration(['passed','failed','unverified']), checks:array(check)}),
  Geburah:object({findings:array(object({severity:enumeration(['info','low','medium','high','critical']), description:nonempty, evidence:text})), recommendations:strings}),
};

export function roleResultSchema(role) {
  role = canonicalRole(role);
  if (!Object.hasOwn(deliverables,role)) throw new Error(`No result contract for role ${role}`);
  return object({status:enumeration(['completed','failed','blocked','unverified']), result:text,
    evidence:strings, changedFiles:strings, assumptions:strings, uncertainty:strings, errors:strings,
    nextAction:text, deliverable:deliverables[role],
    ...(role==='Geburah'?{reviewDecision:enumeration(['approve','request-changes','insufficient-materials']), missingMaterials:strings}:{}),
  });
}

export function requireRoleFields(task) {
  const expected = roleResultSchema(task.role).required;
  if (task.returnFields.length!==expected.length || expected.some(field=>!task.returnFields.includes(field))) {
    throw Object.assign(new Error(`Contract v2 requires exact role fields: ${expected.join(', ')}`),{code:'ROLE_FIELDS_REQUIRED'});
  }
}

function validate(value, schema, path='$') {
  if (schema.type==='object') {
    if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
    if (Object.keys(value).length!==schema.required.length || schema.required.some(k=>!Object.hasOwn(value,k))) throw new Error(`${path} has missing or extra fields`);
    for (const key of schema.required) validate(value[key],schema.properties[key],`${path}.${key}`);
  } else if (schema.type==='array') {
    if (!Array.isArray(value) || value.length>schema.maxItems) throw new Error(`${path} must be a bounded array`);
    value.forEach((item,i)=>validate(item,schema.items,`${path}[${i}]`));
  } else if (schema.type==='string') {
    if (typeof value!=='string' || (schema.minLength && !value.trim()) || (schema.maxLength && value.length>schema.maxLength) || (schema.enum && !schema.enum.includes(value))) throw new Error(`${path} has an invalid string value`);
  } else if (typeof value!==schema.type) throw new Error(`${path} must be ${schema.type}`);
}

export function validateRoleResult(value, role) {
  role = canonicalRole(role);
  try {
    validate(value,roleResultSchema(role));
    if (value.status==='completed') {
      if (!value.result.trim() || !value.evidence.length || value.errors.length) throw new Error('completed requires result, evidence and no errors');
      if (role==='Binah' && value.deliverable.clarificationNeeded) throw new Error('unresolved clarification cannot complete');
      if (role==='Netzach' && (value.deliverable.verdict!=='passed' || !value.deliverable.checks.length || value.deliverable.checks.some(c=>c.outcome!=='passed'||!c.evidence.trim()))) throw new Error('verification completion requires passing checks with evidence');
      if (role==='Chochmah' && (!value.deliverable.steps.length || new Set(value.deliverable.steps.map(s=>s.id)).size!==value.deliverable.steps.length)) throw new Error('completed plan requires uniquely identified steps');
    }
    return {ok:true,version:CONTRACT_VERSION,role};
  } catch(error) { return {ok:false,version:CONTRACT_VERSION,role,code:'role_schema_invalid',message:error.message}; }
}

export function resultDigest(value) {
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(sanitizeResult(value)))).digest('hex');
}

export const ROLE_SCHEMAS = Object.fromEntries(ROLES.map(role=>[role,roleResultSchema(role)]));
