// build.json identifies the deployment served by this origin, not an attestation of executed module bytes.
class BuildMetadata{
  static #current=Object.freeze({id:"unknown",commit:null,updatedAt:null,status:"pending",source:"build.json",executedSourceVerified:false,reason:null});
  static #loading=null;
  static get id(){return this.#current.id}
  static get commit(){return this.#current.commit}
  static get updatedAt(){return this.#current.updatedAt}
  static get status(){return this.#current.status}
  static snapshot(){return this.#current}
  static load(){
    if(this.#loading)return this.#loading;
    this.#loading=(async()=>{
      try{
        const response=await fetch('./build.json',{cache:'no-store',signal:AbortSignal.timeout(3000)});
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const record=await response.json();
        if(!record||record.format!=="source-esm"||typeof record.commit!=="string"||!/^[a-f0-9]{40}$/.test(record.commit)||typeof record.builtAt!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.builtAt)||!Number.isFinite(Date.parse(record.builtAt))||new Date(record.builtAt).toISOString()!==record.builtAt)throw new Error("Invalid deployment metadata");
        this.#current=Object.freeze({id:record.commit,commit:record.commit,updatedAt:record.builtAt,status:"available",source:"build.json",executedSourceVerified:false,reason:null});
      }catch(error){
        this.#current=Object.freeze({...this.#current,id:"unknown",commit:null,updatedAt:null,status:"unavailable",reason:String(error?.message||error)});
      }
      return this.#current;
    })();
    return this.#loading;
  }
}
export { BuildMetadata };
