import type {ZcodeLoginRequest} from '../../src/backend/zcode-login';

export function zcodeLoginService(){
  const calls:Parameters<ZcodeLoginRequest>[0][]=[];
  const request:ZcodeLoginRequest=async input=>{
    calls.push(input);input.signal.throwIfAborted();
    let data:any;
    if(input.url.endsWith('/oauth/cli/init'))data={flow_id:'fixture-flow',expires_at:Math.floor(Date.now()/1000)+300,poll_interval_sec:1,authorize_url:'https://bigmodel.cn/login?appId=zcode&redirect='+encodeURIComponent('https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel?flow_id=fixture-flow')+'&state=fixture-state'};
    else if(input.url.includes('/oauth/cli/poll/'))data={status:'ready',token:'fixture-jwt',user:{user_id:'fixture-user'},bigmodel:{access_token:'fixture-access',refresh_token:'fixture-refresh'}};
    else if(input.url.endsWith('/getCustomerInfo'))data={organizations:[{organizationId:'fixture-org',organizationName:'默认机构',projects:[{projectId:'fixture-project',projectName:'默认项目'}]}]};
    else if(input.url.endsWith('/api_keys')&&input.method==='GET')data=[{name:'zcode-api-key',apiKey:'fixture-key'}];
    else if(input.url.endsWith('/copy/fixture-key'))data={secretKey:'fixture-secret'};
    else throw new Error('Unexpected test request');
    return {status:200,body:{code:0,data}};
  };
  return {calls,request};
}
