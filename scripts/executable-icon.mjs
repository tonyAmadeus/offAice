import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Use the resource editor already owned by electron-builder; no new dependency.
const builderRequire=createRequire(createRequire(import.meta.resolve('electron-builder')).resolve('app-builder-lib'));
const {NtExecutable,NtExecutableResource,Data,Resource}=builderRequire('resedit');

/** Edit only a staged unsigned executable, preserving code and non-icon resources. */
export async function replaceExecutableIcon(executable,iconPath){
  // Signed shells deliberately fail parsing rather than silently discarding a signature.
  const exe=NtExecutable.from(await readFile(executable));
  const resources=NtExecutableResource.from(exe);
  const groups=Resource.IconGroupEntry.fromEntries(resources.entries);
  assert.ok(groups.length,'Desktop executable has no icon group.');
  const icons=Data.IconFile.from(await readFile(iconPath)).icons.map(item=>item.data);
  const digest=data=>createHash('sha256').update(Buffer.from(data??new ArrayBuffer(0))).digest('hex');
  // Resource offsets legitimately move when icon data grows; compare identities and bytes.
  const resourceData=value=>value.entries.filter(entry=>![3,14].includes(entry.type)).map(({type,id,lang,codepage,bin})=>({type,id,lang,codepage,hash:digest(bin)}));
  const otherResources=resourceData(resources);
  const sectionData=value=>value.getAllSections().filter(section=>section.info.name!=='.rsrc').map(section=>({name:section.info.name,hash:digest(section.data)}));
  const codeSections=sectionData(exe);
  for(const group of groups)Resource.IconGroupEntry.replaceIconsForResource(resources.entries,group.id,group.lang,icons);
  resources.outputResource(exe);
  const binary=Buffer.from(exe.generate());
  const checked=NtExecutable.from(binary),checkedResources=NtExecutableResource.from(checked);
  assert.deepEqual(resourceData(checkedResources),otherResources,'Non-icon executable resources changed.');
  assert.deepEqual(sectionData(checked),codeSections,'Executable code sections changed.');
  for(const group of Resource.IconGroupEntry.fromEntries(checkedResources.entries)){
    const iconDigest=item=>digest(item.isRaw()?item.bin:item.generate());
    assert.deepEqual(group.getIconItemsFromEntries(checkedResources.entries).map(iconDigest).sort(),icons.map(iconDigest).sort(),'Embedded icon differs from artwork.');
  }
  await writeFile(executable,binary);
  console.log('Staged EXE icons updated; code and non-icon resources unchanged.');
}
