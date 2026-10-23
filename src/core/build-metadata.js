class BuildMetadata{
  static buildUpdatedAtFromId(buildId){
  if(buildId==="development")return null;
  const m=/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([+-])(\d{2})(\d{2})-/.exec(buildId);
  if(!m)throw new Error(`Invalid BUILD_ID timestamp: ${buildId}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}${m[8]}:${m[9]}`;
}
}
export { BuildMetadata };
