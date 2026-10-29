// Isolated renderer only: no user profile, sessions, tokens or production endpoints.
const {app,BrowserWindow}=require('electron');
const [profile,url]=process.argv.slice(2);
if (!profile || !url?.startsWith('http://127.0.0.1:')) throw Error('Explicit isolated profile and loopback URL required');
app.setPath('userData',profile);
app.whenReady().then(async()=>{
  const window=new BrowserWindow({width:1280,height:940,show:false,
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  await window.loadURL(url);
});
app.on('window-all-closed',()=>app.quit());
