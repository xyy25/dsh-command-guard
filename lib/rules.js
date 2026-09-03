// 默认规则集与默认白名单。
// 规则以字符串正则表达，编译时统一加 "i"（不区分大小写），
// 以便在配置、文档与日志中可读、可序列化。
//
// 级别语义：
//   low      —— 正常放行
//   medium   —— 默认放行，可配置 askMinLevel: "medium" 收紧为询问
//   high     —— 默认询问用户（ask）
//   critical —— 极高危（默认弹卡询问；开启 directDeny 后直接拒绝 deny），
//               可配置 denyMinLevel 调整
/** 所有可用级别，按严重程度升序。 */
export const LEVELS = ["low", "medium", "high", "critical"];
/** 级别 → 排序权重。 */
export const LEVEL_RANK = Object.freeze({
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
});
/**
 * 默认白名单：命中即放行（优先级高于 medium/low 规则，低于 high/critical 规则）。
 * 全部是"明显只读、无副作用"的高频命令前缀。
 */
export const DEFAULT_ALLOW_COMMANDS = [
    "^(?:ls|dir|pwd|Get-Location|Get-ChildItem|Get-Item|Get-Process|Get-Service|Get-Command|Get-Help|Get-Date|Get-NetIPAddress|Get-NetAdapter|Get-ComputerInfo|Get-EnvironmentVariable|Get-WmiObject|man|where|which|tree|Test-Path)\\b",
    "^echo\\b",
    "^Write-Host\\b",
    "^git\\s+(?:status|log|diff|show|remote|rev-parse|ls-files|ls-tree|config|branch\\s+-v)\\b",
    "^git\\s+branch(?!\\s+-[Dd])\\b",
    "^(?:ipconfig|netstat|ping|nslookup|Resolve-DnsName|Test-NetConnection|Get-NetTCPConnection)\\b",
    "^(?:node|npm|pnpm|yarn|git|pwsh|powershell|python|python3|dotnet|java|go|rustc|cargo|docker|kubectl)\\s+(?:-v|--version)\\b",
];
/**
 * 默认规则集。编译时统一加 "i"（不区分大小写）。
 */
export const DEFAULT_RULES = [
    // ===================== critical =====================
    {
        id: "root-recursive-delete",
        level: "critical",
        pattern: "\\b(?:rm|Remove-Item|rd|rmdir|del|erase)\\b[^\\r\\n]*(?:-(?:rf|fr)|-recurse\\b[^\\r\\n]*-force\\b|/s\\s*/q)[^\\r\\n]*[/\\\\]\\s*$",
        description: "递归强制删除根目录/盘符根（如 rm -rf /）",
        hint: "删除目标指向文件系统根，几乎不可能是本意",
    },
    {
        id: "root-wildcard-delete",
        level: "critical",
        pattern: "\\b(?:rm|Remove-Item|del|rd)\\b[^\\r\\n]*(?:-(?:rf|fr)|-recurse\\b[^\\r\\n]*-force\\b|/s\\s*/q)[^\\r\\n]*(?:[/\\\\]\\*|[*?]+\\s*$)",
        description: "递归强制删除根目录通配内容（如 rm -rf /*）",
        hint: "通配符指向根目录的全部内容",
    },
    {
        id: "format-disk",
        level: "critical",
        // 只匹配真正的卷格式化/清盘操作：Format-Volume/Clear-Disk 等 cmdlet、
        // diskpart、或 format 命令带盘符参数（format C:）。
        // 注意不要用裸词 \bformat\b：它会误伤 Format-Table/Format-List 等
        // 只读格式化输出的 cmdlet 与含 "format" 子串的命令。
        pattern: "\\b(?:Format-Volume|Clear-Disk|Clear-Volume|Initialize-Disk|diskpart)\\b|\\bformat\\s+[A-Za-z]:",
        description: "格式化或清空磁盘卷",
        hint: "磁盘格式化不可恢复",
    },
    {
        id: "disable-security",
        level: "critical",
        pattern: "\\bSet-MpPreference\\b[^\\r\\n]*(?:DisableRealtimeMonitoring|DisableBehaviorMonitoring|DisableOnAccessProtection|DisableScriptScanning)",
        description: "关闭 Windows Defender 实时防护",
        hint: "禁用安全防护会暴露系统",
    },
    {
        id: "firewall-off",
        level: "critical",
        pattern: "\\bSet-NetFirewallProfile\\b[^\\r\\n]*-(?:Enabled\\s+\\$false|Disable\\b)",
        description: "关闭 Windows 防火墙配置文件",
        hint: "关闭防火墙降低系统安全等级",
    },
    // ===================== high =====================
    {
        id: "recursive-delete",
        level: "high",
        pattern: "\\b(?:rm|Remove-Item|rd|rmdir|del|erase)\\b[^\\r\\n]*(?:-(?:rf|fr)|-recurse\\b[^\\r\\n]*-force\\b|/s\\s*/q|/q\\s*/s)",
        description: "递归强制删除（rm -rf / Remove-Item -Recurse -Force）",
        hint: "递归删除会移除目录树内所有内容",
    },
    {
        id: "force-delete",
        level: "high",
        pattern: "\\b(?:rm|Remove-Item|del|erase|rd)\\b[^\\r\\n]*-{1,2}(?:f|force)\\b",
        description: "带强制标志删除文件",
        hint: "强制删除跳过确认与只读保护",
    },
    {
        id: "delete-path",
        level: "high",
        pattern: "\\b(?:rm|Remove-Item|rd|rmdir|del|erase)\\b",
        description: "删除文件或目录",
        hint: "删除操作不可撤销（回收站外）",
    },
    {
        id: "clear-content",
        level: "high",
        pattern: "\\b(?:Clear-Content|Clear-Item|Clear-EventLog|truncate)\\b",
        description: "清空文件/项/事件日志内容",
        hint: "清空内容会丢失原有数据",
    },
    {
        id: "registry-delete",
        level: "high",
        pattern: "\\b(?:reg\\s+delete|Remove-ItemProperty|Remove-Item\\s+[^\\r\\n]*(?:HKLM|HKCU|HKCR|HKU))\\b",
        description: "删除注册表键值",
        hint: "注册表删除可能导致系统或应用异常",
    },
    {
        id: "git-destructive",
        level: "high",
        pattern: "\\bgit\\b[^\\r\\n]*(?:push\\b[^\\r\\n]*-{1,2}(?:f|force)\\b|reset\\b[^\\r\\n]*--hard\\b|clean\\b[^\\r\\n]*-{1,2}[a-z]*[fdx]|checkout\\b[^\\r\\n]*--(?!\\S)|branch\\b[^\\r\\n]*-[Dd]\\b|stash\\b[^\\r\\n]*drop\\b|rebase\\b[^\\r\\n]*-i\\b|filter-branch\\b|filter-repo\\b)",
        description: "破坏性 git 操作（强推、硬重置、清理、删分支、改写历史）",
        hint: "会丢失提交或改写远程历史",
    },
    {
        id: "db-destructive",
        level: "high",
        pattern: "\\b(?:drop\\s+(?:database|table|schema|view|index)|truncate\\s+table)\\b|\\bdelete\\s+from\\b(?![^\\r\\n]*\\bwhere\\b)|\\bupdate\\s+[\\w.]+\\s+set\\b(?![^\\r\\n]*\\bwhere\\b)",
        description: "破坏性数据库操作（DROP/TRUNCATE/无 WHERE 的 DELETE/UPDATE）",
        hint: "整表删除或全表更新不可恢复",
    },
    {
        id: "service-control",
        level: "high",
        pattern: "\\b(?:Stop-Service|Restart-Service|Set-Service|Remove-Service|sc\\s+stop|sc\\s+delete|net\\s+stop)\\b",
        description: "停止/删除系统服务",
        hint: "服务操作可能影响系统功能",
    },
    {
        id: "system-shutdown",
        level: "high",
        pattern: "\\b(?:shutdown|Restart-Computer|Stop-Computer)\\b",
        description: "关机/重启计算机",
        hint: "会中断系统与所有会话",
    },
    {
        id: "eval-exec",
        level: "high",
        pattern: "\\b(?:Invoke-Expression|\\biex\\b|\\beval\\b|pwsh\\s+-c|powershell\\s+-(?:c|command)|bash\\s+-c|cmd\\s+/c)\\b",
        description: "动态执行命令字符串",
        hint: "动态拼接的命令难以静态审计",
    },
    {
        id: "download-pipe-exec",
        level: "high",
        pattern: "\\b(?:curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\\b[^\\r\\n]*\\|\\s*(?:sh|bash|iex|powershell|pwsh|python|python3|cmd)\\b",
        description: "下载脚本并直接执行",
        hint: "远程脚本内容不可信，存在供应链风险",
    },
    {
        id: "execution-policy",
        level: "high",
        pattern: "\\bSet-ExecutionPolicy\\b[^\\r\\n]*(?:Unrestricted|Bypass)",
        description: "放宽 PowerShell 执行策略",
        hint: "放宽执行策略会允许任意脚本运行",
    },
    {
        id: "account-admin",
        level: "high",
        pattern: "\\b(?:net\\s+(?:user|localgroup)|Add-LocalGroupMember|Remove-LocalGroupMember|Set-LocalUser|Enable-LocalUser|Disable-LocalUser|New-LocalUser|Remove-LocalUser)\\b",
        description: "账户/用户组管理操作",
        hint: "账户权限变更影响访问控制",
    },
    {
        id: "credential-export",
        level: "high",
        pattern: "\\b(?:Export-Clixml|Export-Csv)\\b[^\\r\\n]*(?:credential|password|secret|token)",
        description: "导出凭据/口令相关数据",
        hint: "凭据导出可能泄露敏感信息",
    },
    {
        id: "remoting",
        level: "high",
        pattern: "\\b(?:Enable-PSRemoting|New-PSSession|Enter-PSSession|Invoke-Command\\b[^\\r\\n]*-ComputerName)\\b",
        description: "启用/使用远程会话",
        hint: "远程执行面扩大攻击范围",
    },
    // ===================== medium =====================
    {
        id: "sensitive-file-read",
        level: "medium",
        pattern: "\\b(?:Get-Content|cat|type|Select-String|Get-Item|Get-ChildItem)\\b[^\\r\\n]*(?:\\.env(?:\\.\\w+)?|\\.pem\\b|\\.key\\b|\\.npmrc\\b|\\.htpasswd\\b|id_rsa\\b|id_ed25519\\b|password\\b|secret\\b|credential\\b)",
        description: "读取可能包含凭据的敏感文件",
        hint: "文件可能含密钥/口令",
    },
    {
        id: "system-dir-write",
        level: "medium",
        pattern: "\\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|ren|mv|cp|install)\\b[^\\r\\n]*(?:C:\\\\Windows|C:\\\\Program Files|C:\\\\ProgramData|/etc/|/usr/|/bin/|/var/|/System/|/Library/)",
        description: "写入或修改系统目录",
        hint: "系统目录改动可能破坏系统",
    },
    {
        id: "container-destructive",
        level: "medium",
        pattern: "\\b(?:docker\\s+(?:rm|rmi|stop|kill|system\\s+prune)|docker\\s+compose\\s+down|podman\\s+(?:rm|rmi|stop|kill)|kubectl\\s+(?:delete|drain)|Remove-Container)\\b",
        description: "容器/编排资源删除或停止",
        hint: "容器数据卷可能随之销毁",
    },
    {
        id: "kill-process",
        level: "medium",
        pattern: "\\b(?:Stop-Process|taskkill|kill\\b)\\b",
        description: "终止进程",
        hint: "终止进程可能导致工作丢失",
    },
    {
        id: "permissions-change",
        level: "medium",
        pattern: "\\b(?:chmod|chown|icacls|Set-Acl|Takeown)\\b",
        description: "修改文件权限/所有者",
        hint: "权限变更影响访问控制",
    },
    {
        id: "package-uninstall-global",
        level: "medium",
        pattern: "\\b(?:npm\\s+uninstall\\s+-g|pnpm\\s+remove\\s+-g|yarn\\s+global\\s+remove|pip\\s+uninstall|Remove-Module|Uninstall-Package)\\b",
        description: "卸载全局软件包",
        hint: "全局卸载影响所有项目",
    },
    {
        id: "rmdir-empty",
        level: "medium",
        pattern: "\\b(?:rmdir|rd)\\b(?!.*(?:/s|\\s*-s\\b))",
        description: "删除空目录",
        hint: "仅删除空目录",
    },
];
