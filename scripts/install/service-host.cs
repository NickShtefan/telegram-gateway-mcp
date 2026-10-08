// Fixed virtual-account service host. No general command, path or model execution API.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
public sealed class GatewayService : ServiceBase {
    private Process child;
    private bool ownerSetup;
    public GatewayService() { ServiceName="TelegramMCPGateway"; CanStop=true; AutoLog=false; }
    private static string Text(Dictionary<string,object> config,string key) {
        object value; if(!config.TryGetValue(key,out value)||!(value is string))throw new InvalidDataException();return (string)value;
    }
    private static string Quoted(string path) { if(path.IndexOf('"')>=0||path.IndexOf('\r')>=0||path.IndexOf('\n')>=0)throw new InvalidDataException();return "\""+path+"\""; }
    protected override void OnStart(string[] args) {
        try {
            ownerSetup=args.Length==2&&args[0]=="owner-setup"&&Regex.IsMatch(args[1],"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
            if(args.Length!=0&&!ownerSetup)throw new InvalidDataException();
            string common=Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            string prefix=Path.Combine(common,"TelegramMCPGateway");
            string file=Path.Combine(prefix,"service.json");
            var info=new FileInfo(file);if(!info.Exists||info.Length>16384||(info.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidDataException();
            var config=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file));
            string node=Text(config,"node"),entry=Text(config,"entry"),state=Text(config,"state"),files=Text(config,"files"),logs=Text(config,"logs");
            string release=Path.GetDirectoryName(node);string sha=Path.GetFileName(release);
            if(!Regex.IsMatch(sha,"^[0-9a-f]{40}$")||!String.Equals(release,Path.Combine(prefix,"releases",sha),StringComparison.OrdinalIgnoreCase)
                ||!String.Equals(node,Path.Combine(release,"node.exe"),StringComparison.OrdinalIgnoreCase)
                ||!String.Equals(entry,Path.Combine(release,"application","dist","cli","index.js"),StringComparison.OrdinalIgnoreCase)
                ||!String.Equals(state,Path.Combine(prefix,"state"),StringComparison.OrdinalIgnoreCase)
                ||!String.Equals(files,Path.Combine(prefix,"files"),StringComparison.OrdinalIgnoreCase)
                ||!String.Equals(logs,Path.Combine(prefix,"logs"),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException();
            int port=Convert.ToInt32(config["port"]);if(port<1||port>65535||Text(config,"toolsets")!="core")throw new InvalidDataException();
            string command=ownerSetup?Quoted(Path.Combine(release,"application","dist","setup","ownerWindows.js"))+" "+args[1]:Quoted(entry)+" serve --toolsets core --host 127.0.0.1 --port "+port+" --files-dir "+Quoted(files);
            var start=new ProcessStartInfo(node,command);
            start.UseShellExecute=false;start.CreateNoWindow=true;start.WorkingDirectory=release;
            start.EnvironmentVariables.Clear();start.EnvironmentVariables["SystemRoot"]=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            start.EnvironmentVariables["PATH"]=Path.Combine(start.EnvironmentVariables["SystemRoot"],"System32");start.EnvironmentVariables["TG_MCP_HOME"]=state;
            start.RedirectStandardOutput=true;start.RedirectStandardError=true;
            child=new Process();child.StartInfo=start;child.EnableRaisingEvents=true;
            child.OutputDataReceived+=(sender,eventArgs)=>{if(!ownerSetup&&eventArgs.Data!=null)Append(logs,"stdout.log",eventArgs.Data);};
            child.ErrorDataReceived+=(sender,eventArgs)=>{if(!ownerSetup&&eventArgs.Data!=null)Append(logs,"stderr.log",eventArgs.Data);};
            child.Exited+=(sender,eventArgs)=>{ExitCode=ownerSetup?0:1;Stop();};
            if(!child.Start())throw new InvalidDataException();child.BeginOutputReadLine();child.BeginErrorReadLine();
        } catch { ExitCode=1;throw new InvalidOperationException("gateway_service_start_failed"); }
    }
    private static readonly object logLock=new object();
    private static void Append(string directory,string name,string line) { lock(logLock){try{File.AppendAllText(Path.Combine(directory,name),line+Environment.NewLine);}catch{}} }
    protected override void OnStop() { if(child!=null){try{if(!child.HasExited)child.Kill();child.WaitForExit();}catch{throw new InvalidOperationException("gateway_worker_stop_failed");}child.Dispose();child=null;} }
    public static void Main() { ServiceBase.Run(new GatewayService()); }
}
