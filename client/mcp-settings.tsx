import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { mcpPreview, mcpRead, mcpSave } from "../shared/mcp-contracts";
import { McpHarness, type ScopedProject, ScopedServer } from "../shared/scoped-mcp.mjs";

type Project = z.infer<typeof ScopedProject>;
type Props = {
  cwd: string;
  title: string;
  hostId: string;
  theme: PluginSurfaceProps["theme"];
  onClose: () => void;
};

export function McpSettings(props: Props) {
  const read = useRpc(mcpRead);
  const state = useQuery({ queryKey: ["alliance-mcp", props.hostId], queryFn: () => read({}), retry: false });
  return (
    <Modal
      open
      title={`MCP · ${props.title}`}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Modal.Content contentContainerStyle={{ padding: 16 }}>
        {state.error && <Text style={{ color: props.theme.colors.foreground }}>{String(state.error)}</Text>}
        {!state.data && !state.error && (
          <Text style={{ color: props.theme.colors.foreground }}>Loading MCP settings…</Text>
        )}
        {state.data && (
          <Editor
            key={state.data.revision}
            {...props}
            revision={state.data.revision}
            initial={
              state.data.config.projects.find((entry) => entry.root === props.cwd) ?? {
                root: props.cwd,
                harnesses: ["codex", "claude", "agy", "pi"],
                servers: {},
              }
            }
            reload={() => {
              void state.refetch();
            }}
          />
        )}
      </Modal.Content>
    </Modal>
  );
}

function Editor({
  cwd,
  hostId,
  theme,
  revision,
  initial,
  reload,
}: Props & { revision: string; initial: Project; reload: () => void }) {
  const c = theme.colors;
  const [project, setProject] = useState(initial);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [allowOnly, setAllowOnly] = useState(true);
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [error, setError] = useState("");
  const [harness, setHarness] = useState<z.infer<typeof McpHarness>>("codex");
  const saveRpc = useRpc(mcpSave);
  const previewRpc = useRpc(mcpPreview);
  const preview = useQuery({
    queryKey: ["alliance-mcp-preview", hostId, cwd, harness, revision],
    queryFn: () => previewRpc({ cwd, harness }),
    retry: false,
  });
  const save = useMutation({
    mutationFn: (value: Project | null) => saveRpc({ root: cwd, project: value, revision }),
    onSuccess: reload,
  });
  const text = { color: c.foreground, fontSize: 13 };
  const muted = { color: c.foregroundMuted, fontSize: 12 };
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 };
  const button = (label: string, action: () => void, selected = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={save.isPending}
      accessibilityState={{ selected, disabled: save.isPending }}
      onPress={action}
      style={{ padding: 9, borderRadius: 6, borderWidth: 1, borderColor: selected ? c.accent : c.border }}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
  const field = (label: string, value: string, change: (value: string) => void, multiline = false) => (
    <View style={{ gap: 4 }}>
      <Text style={muted}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={change}
        multiline={multiline}
        editable={!save.isPending}
        style={{
          ...text,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 6,
          padding: 8,
          minHeight: multiline ? 65 : 36,
        }}
      />
    </View>
  );
  const lines = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const reset = () => {
    setEditing(null);
    setName("");
    setCommand("");
    setArgs("");
    setRestricted(false);
    setAllowOnly(true);
    setAllow("");
    setDeny("");
    setError("");
  };
  return (
    <ScrollView style={{ maxHeight: 650 }} contentContainerStyle={{ gap: 12 }}>
      <Text selectable style={muted}>
        {cwd}
      </Text>
      <Text style={muted}>
        Applies to this directory and its descendants. Worktrees outside this directory need their own entry.
        Keep credentials in the server's own authentication store.
      </Text>
      <Text style={text}>Enabled agents</Text>
      <View style={row}>
        {McpHarness.options.map((value) => (
          <View key={value}>
            {button(
              value,
              () =>
                setProject({
                  ...project,
                  harnesses: project.harnesses.includes(value)
                    ? project.harnesses.filter((item) => item !== value)
                    : [...project.harnesses, value],
                }),
              project.harnesses.includes(value),
            )}
          </View>
        ))}
      </View>
      {Object.entries(project.servers).map(([key, server]) => (
        <View
          key={key}
          style={{ gap: 6, padding: 10, borderWidth: 1, borderColor: c.border, borderRadius: 6 }}
        >
          <Text style={text}>
            {key} · {server.tools ? "Tool restrictions" : "All server capabilities"}
          </Text>
          <Text selectable style={muted}>
            {server.command}
          </Text>
          <View style={row}>
            {button(`Edit ${key}`, () => {
              setEditing(key);
              setName(key);
              setCommand(server.command);
              setArgs(JSON.stringify(server.args));
              setRestricted(!!server.tools);
              setAllowOnly(server.tools?.allow !== undefined);
              setAllow((server.tools?.allow ?? []).join("\n"));
              setDeny((server.tools?.deny ?? []).join("\n"));
              setError("");
            })}
            {button(`Remove ${key}`, () => {
              const servers = { ...project.servers };
              delete servers[key];
              setProject({ ...project, servers });
              if (editing === key) reset();
            })}
          </View>
        </View>
      ))}
      <Text style={text}>{editing ? `Edit server ${editing}` : "Add MCP server"}</Text>
      {field("Server name", name, setName)}
      {field("Executable (absolute path on this host)", command, setCommand)}
      {field('Arguments (JSON array, e.g. ["/path/server.mjs", "--stdio"])', args, setArgs, true)}
      {button("Restrict tools", () => setRestricted(!restricted), restricted)}
      {restricted && (
        <>
          <Text style={muted}>
            Uses exact upstream tool names. Deny takes precedence. Restricted servers expose tools only;
            prompts, resources and server-initiated requests are unavailable.
          </Text>
          {button("Allow only listed tools", () => setAllowOnly(!allowOnly), allowOnly)}
          {allowOnly && field("Allowed tools (one per line; empty means none)", allow, setAllow, true)}
          {field("Denied tools (one per line)", deny, setDeny, true)}
        </>
      )}
      <View style={row}>
        {button(editing ? "Apply server edit" : "Add to project", () => {
          try {
            const server = ScopedServer.parse({
              command,
              args: JSON.parse(args || "[]"),
              ...(restricted
                ? { tools: { ...(allowOnly ? { allow: lines(allow) } : {}), deny: lines(deny) } }
                : {}),
            });
            if (
              !name ||
              (!editing && Object.hasOwn(project.servers, name)) ||
              (editing !== name && Object.hasOwn(project.servers, name))
            )
              throw new Error("Choose a unique server name");
            const servers = { ...project.servers };
            if (editing) delete servers[editing];
            setProject({ ...project, servers: { ...servers, [name]: server } });
            reset();
          } catch (e) {
            setError(String(e));
          }
        })}
        {editing && button("Cancel edit", reset)}
      </View>
      {(error || save.error) && (
        <Text accessibilityRole="alert" style={text}>
          {error || String(save.error)}
        </Text>
      )}
      <Text style={muted}>
        Save affects newly opened runtimes. Existing sessions may retain tools: finish and recreate them to
        apply or revoke access. No running agent is interrupted.
      </Text>
      <View style={row}>
        {button(save.isPending ? "Saving…" : "Save project MCP", () => {
          if (editing || name || command || args) {
            setError("Apply or cancel the server edit before saving");
            return;
          }
          save.mutate(project);
        })}
        {button("Remove project override", () => save.mutate(null))}
        {button("Reload saved settings", reload)}
      </View>
      <Text style={text}>Effective saved servers</Text>
      <View style={row}>
        {McpHarness.options.map((value) => (
          <View key={value}>{button(`Preview ${value}`, () => setHarness(value), value === harness)}</View>
        ))}
      </View>
      <Text style={muted}>
        {preview.isFetching
          ? "Loading…"
          : preview.error
            ? String(preview.error)
            : Object.keys(preview.data?.servers ?? {}).join(", ") || "No extra servers"}
      </Text>
      <Text style={muted}>
        Includes inherited project entries and global Mobbin where enabled. The built-in Paseo connection is
        managed separately.
      </Text>
    </ScrollView>
  );
}
