export interface TransferProgress {
  label: string;
  phase: "compress" | "upload" | "extract";
  bytesDone: number;
  bytesTotal: number;
}

export enum PushProgressId {
  Snapshotting = "snapshotting",
  CreatingSandbox = "creating_sandbox",
  UploadingBundle = "uploading_bundle",
  InstallingRuntime = "installing_runtime",
  RestoringSession = "restoring_session",
  Ready = "ready",
}

export type PushProgressEvent =
  | { step: PushProgressId.Snapshotting }
  | { step: PushProgressId.CreatingSandbox }
  | { step: PushProgressId.UploadingBundle }
  | {
      step: PushProgressId.InstallingRuntime;
      packageName: string;
      version: string;
    }
  | { step: PushProgressId.RestoringSession }
  | { step: PushProgressId.Ready };

export type PushProgressListener = (event: PushProgressEvent) => void;

export enum EnrichmentStepId {
  Setup = "setup",
  ProfileTransfer = "profile_transfer",
  SettingsScriptsTransfer = "settings_scripts_transfer",
  SettingsScriptDependencyInstalls = "settings_script_dependency_installs",
  McpCodeTransfer = "mcp_code_transfer",
  McpDependencyInstalls = "mcp_dependency_installs",
  PluginGitSkillReinstall = "plugin_git_skill_reinstall",
}

export type EnrichmentProgressEvent =
  | {
      kind: "enrichStep";
      step: EnrichmentStepId;
      status: "start" | "ok" | "fail";
    }
  | { kind: "transfer"; transfer: TransferProgress };

export type EnrichmentProgressListener = (
  event: EnrichmentProgressEvent,
) => void;
