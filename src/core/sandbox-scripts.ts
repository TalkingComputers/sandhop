import { CLAUDE_JSON_PATH } from "../agents/claude-paths.js";

export const buildClaudePreSeedScript = (remoteProj: string): string =>
  [
    'const fs=require("fs")',
    `const f=process.env.HOME+${JSON.stringify(`/${CLAUDE_JSON_PATH}`)}`,
    'const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{}',
    "j.hasCompletedOnboarding=true",
    'if(!Object.hasOwn(j,"projects"))j.projects={}',
    `j.projects[${JSON.stringify(remoteProj)}]={hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}`,
    "fs.writeFileSync(f,JSON.stringify(j))",
  ].join(";");

export const buildCodexPreSeedScript = (remoteProj: string): string =>
  [
    'const fs=require("fs")',
    'const f=process.env.HOME+"/.codex/config.toml"',
    `const project=${JSON.stringify(remoteProj)}`,
    'const projectHeader="[projects."+JSON.stringify(project)+"]"',
    'const root=["cli_auth_credentials_store = \\"file\\""]',
    "const rootKey=/^(cli_auth_credentials_store)\\s*=/",
    'let lines=fs.existsSync(f)?fs.readFileSync(f,"utf8").split(/\\r?\\n/):[]',
    'if(lines.length===1&&lines[0]==="")lines=[]',
    "let table=false",
    "const kept=[]",
    "for(const line of lines){if(/^\\s*\\[/.test(line))table=true;if(!table&&rootKey.test(line.trim()))continue;kept.push(line)}",
    "const withoutProject=[]",
    "for(let i=0;i<kept.length;i++){if(kept[i].trim()===projectHeader){i++;while(i<kept.length&&!/^\\s*\\[/.test(kept[i]))i++;i--}else withoutProject.push(kept[i])}",
    'while(withoutProject[withoutProject.length-1]==="")withoutProject.pop()',
    "const firstTable=withoutProject.findIndex(line=>/^\\s*\\[/.test(line))",
    "const beforeRoot=firstTable===-1?withoutProject:withoutProject.slice(0,firstTable)",
    "const afterRoot=firstTable===-1?[]:withoutProject.slice(firstTable)",
    "const out=[...beforeRoot]",
    'if(out.length>0&&out[out.length-1]!=="")out.push("")',
    "out.push(...root)",
    'if(afterRoot.length>0)out.push("",...afterRoot)',
    'out.push("",projectHeader,"trust_level = \\"trusted\\"")',
    'fs.mkdirSync(process.env.HOME+"/.codex",{recursive:true})',
    'fs.writeFileSync(f,out.join("\\n")+"\\n")',
  ].join(";");

export const buildPruneMcpTablesScript = (path: string): string =>
  [
    'const fs=require("fs")',
    `const f=${JSON.stringify(path)}.replace("$HOME",process.env.HOME)`,
    'const lines=fs.readFileSync(f,"utf8").split(/\\r?\\n/)',
    "const out=[]",
    "let skip=false",
    "for(const line of lines){if(/^\\s*\\[mcp_servers(?:\\.|\\])/.test(line)){skip=true;continue}if(skip&&/^\\s*\\[/.test(line))skip=false;if(!skip)out.push(line)}",
    'fs.writeFileSync(f,out.join("\\n").replace(/\\n*$/,"\\n"))',
  ].join(";");

export const buildMergeClaudeMcpScript = (
  path: string,
  content: string,
): string =>
  [
    'const fs=require("fs")',
    `const f=${JSON.stringify(path)}.replace("$HOME",process.env.HOME)`,
    `const s=JSON.parse(${JSON.stringify(content)})`,
    'const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{}',
    "j.mcpServers=s",
    'fs.writeFileSync(f,JSON.stringify(j,null,2)+"\\n")',
  ].join(";");
