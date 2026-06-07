import {
  EnrichmentStepId,
  PushProgressId,
  type EnrichmentProgressEvent,
  type PushProgressEvent,
} from "../core/ports/progress.js";

const PUSH_PROGRESS_LABELS: Record<PushProgressId, string> = {
  [PushProgressId.Snapshotting]: "Snapshotting session",
  [PushProgressId.CreatingSandbox]: "Creating cloud sandbox",
  [PushProgressId.UploadingBundle]: "Shipping working tree + session",
  [PushProgressId.InstallingRuntime]: "Installing agent runtime + terminal",
  [PushProgressId.RestoringSession]: "Restoring your session",
  [PushProgressId.Ready]: "Ready",
};

export const formatPushProgress = (event: PushProgressEvent): string => {
  if (event.step === PushProgressId.InstallingRuntime)
    return `${PUSH_PROGRESS_LABELS[PushProgressId.InstallingRuntime]} (${event.packageName}@${event.version})`;
  return PUSH_PROGRESS_LABELS[event.step];
};

const ENRICHMENT_PROGRESS_LABELS: Record<EnrichmentStepId, string> = {
  [EnrichmentStepId.Setup]: "Preparing",
  [EnrichmentStepId.ProfileTransfer]: "Transferring profile & skills",
  [EnrichmentStepId.SettingsScriptsTransfer]: "Transferring settings scripts",
  [EnrichmentStepId.SettingsScriptDependencyInstalls]:
    "Installing settings-script deps",
  [EnrichmentStepId.McpCodeTransfer]: "Transferring MCP servers",
  [EnrichmentStepId.McpDependencyInstalls]: "Installing MCP deps",
  [EnrichmentStepId.PluginGitSkillReinstall]: "Reinstalling plugins & skills",
};

export const formatEnrichmentProgress = (
  event: Extract<EnrichmentProgressEvent, { kind: "enrichStep" }>,
): string => ENRICHMENT_PROGRESS_LABELS[event.step];
