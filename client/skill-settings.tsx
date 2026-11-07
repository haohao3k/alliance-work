import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { skillsInstall, skillsPreview, skillsRead, skillsSave } from "../shared/skill-contracts";
import type { SkillSettings as Settings } from "../shared/skill-settings.mjs";

type Props = {
  cwd: string;
  title: string;
  hostId: string;
  theme: PluginSurfaceProps["theme"];
  onClose: () => void;
};

export function SkillSettings(props: Props) {
  const [notice, setNotice] = useState("");
  const read = useRpc(skillsRead);
  const cache = useQueryClient();
  const queryKey = ["alliance-skills", props.hostId, props.cwd];
  const state = useQuery({
    queryKey,
    queryFn: () => read({ cwd: props.cwd }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <Modal
      open
      title={`Skills · ${props.title}`}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Modal.Content contentContainerStyle={{ padding: 16 }}>
        {!!notice && (
          <Text accessibilityLiveRegion="polite" style={{ color: props.theme.colors.foreground }}>
            {notice}
          </Text>
        )}
        {state.error && (
          <Text accessibilityRole="alert" style={{ color: props.theme.colors.foreground }}>
            {String(state.error)}
          </Text>
        )}
        {!state.data && !state.error && (
          <Text style={{ color: props.theme.colors.foreground }}>Loading project skills…</Text>
        )}
        {state.data ? (
          <Editor
            key={state.data.revision}
            {...props}
            initial={state.data}
            saved={(value) => {
              cache.setQueryData(queryKey, value);
              setNotice("Project skills saved. New sessions will use this selection.");
            }}
            reload={() => {
              setNotice("");
              void state.refetch();
            }}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void state.refetch();
            }}
          >
            <Text style={{ color: props.theme.colors.foreground }}>Retry</Text>
          </Pressable>
        )}
      </Modal.Content>
    </Modal>
  );
}

function Editor({
  theme,
  initial,
  saved,
  reload,
}: Props & {
  initial: z.infer<typeof Settings>;
  saved: (value: z.infer<typeof Settings>) => void;
  reload: () => void;
}) {
  const c = theme.colors;
  const [selected, setSelected] = useState(initial.selected);
  const [disabledBundled, setDisabledBundled] = useState(initial.disabledBundled);
  const [showBundled, setShowBundled] = useState(false);
  const [source, setSource] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const saveRpc = useRpc(skillsSave),
    previewRpc = useRpc(skillsPreview),
    installRpc = useRpc(skillsInstall);
  const save = useMutation({
    mutationFn: () => saveRpc({ cwd: initial.root, selected, disabledBundled, revision: initial.revision }),
    onSuccess: saved,
  });
  const preview = useMutation({
    mutationFn: () => previewRpc({ source }),
    onSuccess: () => {
      setChosen([]);
      setExpanded(null);
    },
  });
  const install = useMutation({
    mutationFn: () => {
      if (!preview.data) throw new Error("Preview a source first");
      return installRpc({
        cwd: initial.root,
        source: preview.data.source,
        commit: preview.data.commit,
        requested: preview.data.skills
          .filter((s) => chosen.includes(s.path))
          .map(({ path, digest }) => ({ path, digest })),
        revision: initial.revision,
      });
    },
    onSuccess: saved,
  });
  const busy = save.isPending || preview.isPending || install.isPending;
  const dirty =
    JSON.stringify(selected) !== JSON.stringify(initial.selected) ||
    JSON.stringify(disabledBundled) !== JSON.stringify(initial.disabledBundled);
  const text = { color: c.foreground, fontSize: 13 };
  const muted = { color: c.foregroundMuted, fontSize: 12 };
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 };
  const card = { padding: 10, gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: 6 };
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy || disabled }}
      disabled={busy || disabled}
      onPress={action}
      style={{
        padding: 9,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 6,
        opacity: busy || disabled ? 0.5 : 1,
      }}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
  const toggle = (name: string, checked: boolean, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={name}
      accessibilityState={{ checked, disabled: busy || disabled }}
      disabled={busy || disabled}
      onPress={action}
      style={{
        padding: 8,
        borderWidth: 1,
        borderColor: checked ? c.accent : c.border,
        borderRadius: 6,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={text}>
        {checked ? "☑" : "☐"} {name}
      </Text>
    </Pressable>
  );
  return (
    <ScrollView style={{ maxHeight: 650 }} contentContainerStyle={{ gap: 12 }}>
      <Text selectable style={muted}>
        {initial.root}
      </Text>
      <Text style={muted}>
        Choose the skills available to agents in this project. Changes apply to new sessions; running agents
        keep their current skills.
      </Text>
      <View style={row}>
        {button(
          save.isPending ? "Saving…" : "Save selection",
          () => save.mutate(),
          !dirty || selected.some((p) => initial.available.find((s) => s.path === p)?.error !== null),
        )}
        {button("Reload project skills", reload)}
      </View>
      {button(
        `Bundled skills · ${initial.bundled.length - disabledBundled.length}/${initial.bundled.length} enabled · ${showBundled ? "Hide" : "Show"}`,
        () => setShowBundled(!showBundled),
      )}
      {showBundled && (
        <>
          <Text style={muted}>
            These skills ship with Alliance. Toggles apply to this project across all harnesses and the listed
            roles, including Lens. Other projects keep their own selection. Core operating policies are
            separate from skills.
          </Text>
          <View style={row}>
            {button("Disable all bundled skills", () =>
              setDisabledBundled(initial.bundled.map((s) => s.name)),
            )}
            {button("Restore bundled defaults", () => setDisabledBundled([]))}
          </View>
          {initial.bundled.map((skill) => (
            <View key={skill.name} style={card}>
              {toggle(skill.name, !disabledBundled.includes(skill.name), () =>
                setDisabledBundled(
                  disabledBundled.includes(skill.name)
                    ? disabledBundled.filter((n) => n !== skill.name)
                    : [...disabledBundled, skill.name],
                ),
              )}
              <Text style={muted}>{skill.description}</Text>
              <Text style={muted}>
                {skill.source} · {skill.roles.join(", ")}
              </Text>
            </View>
          ))}
        </>
      )}
      <Text style={text}>Project skills · {selected.length} enabled</Text>
      {!initial.available.length && (
        <Text style={muted}>
          No skills installed yet. Add skills from GitHub below, or place a skill in this project's
          .agents/skills folder and reload.
        </Text>
      )}
      {initial.available.map((skill) => {
        const checked = selected.includes(skill.path);
        return (
          <View key={skill.path} style={card}>
            {toggle(
              skill.name,
              checked,
              () =>
                setSelected(checked ? selected.filter((p) => p !== skill.path) : [...selected, skill.path]),
              !!skill.error && !checked,
            )}
            <Text style={muted}>{skill.description || "Skill unavailable"}</Text>
            <Text selectable style={muted}>
              {skill.directory}
            </Text>
            {skill.error && (
              <Text accessibilityRole="alert" style={text}>
                {skill.error}
                {checked ? " Disable this skill to save a valid selection." : ""}
              </Text>
            )}
          </View>
        );
      })}
      {dirty && <Text style={muted}>Unsaved selection. Save or reload before installing new skills.</Text>}
      <Text style={text}>Add from GitHub</Text>
      <Text style={muted}>Paste a GitHub URL, owner/repo, or npx skills add owner/repo --skill name.</Text>
      <TextInput
        accessibilityLabel="Skill source"
        value={source}
        editable={!busy}
        onChangeText={(value) => {
          setSource(value);
          preview.reset();
          setChosen([]);
        }}
        placeholder="https://github.com/owner/repo"
        style={{ ...text, padding: 10, borderWidth: 1, borderColor: c.border, borderRadius: 6 }}
      />
      {button(
        preview.isPending ? "Reading source…" : "Preview skills",
        () => preview.mutate(),
        !source.trim() || dirty,
      )}
      {preview.data && (
        <>
          <Text selectable style={muted}>
            {preview.data.repository} · {preview.data.commit.slice(0, 12)}
          </Text>
          {!preview.data.skills.length && (
            <Text style={muted}>No installable skills found at this source.</Text>
          )}
          {preview.data.errors.map((error) => (
            <Text key={error.path} accessibilityRole="alert" style={muted}>
              {error.path}: {error.error}
            </Text>
          ))}
          {preview.data.skills.map((skill) => {
            const exists = initial.available.some((s) => s.name === skill.name);
            const checked = chosen.includes(skill.path);
            return (
              <View key={skill.path} style={card}>
                {toggle(
                  `${skill.name}${exists ? " · Already installed" : ""}`,
                  checked,
                  () => setChosen(checked ? chosen.filter((p) => p !== skill.path) : [...chosen, skill.path]),
                  exists,
                )}
                <Text style={muted}>{skill.description}</Text>
                <Text selectable style={muted}>
                  {skill.path || "/"} · {Math.ceil(skill.bytes / 1024)} KB
                </Text>
                {button(
                  expanded === skill.path
                    ? `Hide ${skill.name} instructions`
                    : `Read ${skill.name} instructions`,
                  () => setExpanded(expanded === skill.path ? null : skill.path),
                )}
                {expanded === skill.path && (
                  <Text selectable style={muted}>
                    {skill.body}
                  </Text>
                )}
              </View>
            );
          })}
          {button(
            install.isPending ? "Installing…" : `Install & enable (${chosen.length})`,
            () => install.mutate(),
            !chosen.length || dirty,
          )}
        </>
      )}
      {(save.error || preview.error || install.error) && (
        <Text accessibilityRole="alert" style={text}>
          {String(save.error || preview.error || install.error)}
        </Text>
      )}
      <Text style={muted}>
        Disabling a skill keeps its files. Installation preserves existing skills and records the source
        commit. GitHub access uses this host's Git credentials.
      </Text>
    </ScrollView>
  );
}
