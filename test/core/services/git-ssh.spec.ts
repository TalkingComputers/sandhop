import { expect, test } from "vitest";
import { GitSshService } from "../../../src/core/services/git-ssh.js";
import { FakeHost } from "../../fakes/host.js";

test("GitSshService collects only SSH remote keys, known hosts, and config", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.ssh/github_key": "PRIVATE\n",
      "/home/local/.ssh/github_key.pub": "PUBLIC\n",
      "/home/local/.ssh/unused": "UNUSED\n",
    },
    execValues: {
      "git -C /workspace/project remote -v": [
        "origin\tgit@github.com:org/repo.git (fetch)",
        "origin\tgit@github.com:org/repo.git (push)",
        "mirror\tssh://git@gitlab.example.com:2222/org/repo.git (fetch)",
        "web\thttps://github.com/org/repo.git (fetch)",
      ].join("\n"),
      "ssh -T -G github.com": [
        "hostname github.com",
        "user git",
        "port 22",
        "identityfile ~/.ssh/github_key",
        "identityfile ~/.ssh/missing",
      ].join("\n"),
      "ssh -T -G gitlab.example.com": [
        "hostname ssh.gitlab.example.com",
        "user git",
        "port 2222",
        "identityfile /home/local/.ssh/github_key",
      ].join("\n"),
      "ssh-keyscan -p 22 github.com": "github.com ssh-ed25519 AAA\n",
      "ssh-keyscan -p 2222 ssh.gitlab.example.com":
        "[ssh.gitlab.example.com]:2222 ssh-ed25519 BBB\n",
    },
  });

  const bundle = new GitSshService(host).collect("/workspace/project");

  expect(bundle.dirs).toEqual([{ path: "$HOME/.ssh", mode: "700" }]);
  expect(bundle.hosts).toEqual(["github.com", "gitlab.example.com"]);
  expect(bundle.files).toContainEqual({
    path: "$HOME/.ssh/github_key",
    content: "PRIVATE\n",
    mode: "600",
  });
  expect(bundle.files).toContainEqual({
    path: "$HOME/.ssh/github_key.pub",
    content: "PUBLIC\n",
    mode: "644",
  });
  expect(bundle.files).toContainEqual({
    path: "$HOME/.ssh/known_hosts",
    content:
      "github.com ssh-ed25519 AAA\n[ssh.gitlab.example.com]:2222 ssh-ed25519 BBB\n",
    mode: "644",
  });
  expect(bundle.files).toContainEqual({
    path: "$HOME/.ssh/config",
    content: [
      "Host github.com",
      "  HostName github.com",
      "  User git",
      "  Port 22",
      "  IdentityFile ~/.ssh/github_key",
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking accept-new",
      "  RequestTTY no",
      "Host gitlab.example.com",
      "  HostName ssh.gitlab.example.com",
      "  User git",
      "  Port 2222",
      "  IdentityFile ~/.ssh/github_key",
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking accept-new",
      "  RequestTTY no",
      "",
    ].join("\n"),
    mode: "600",
  });
  expect(bundle.files.map((file) => file.path)).not.toContain(
    "$HOME/.ssh/unused",
  );
});

test("GitSshService returns an empty bundle when git or ssh data is absent", () => {
  expect(
    new GitSshService(new FakeHost({ home: "/home/local", env: {} })).collect(
      "/workspace/project",
    ),
  ).toEqual({ files: [], dirs: [], hosts: [] });
});
