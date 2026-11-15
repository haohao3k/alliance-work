import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { projectClaudeAccountRead, projectClaudeAccountSelect } from "../shared/claude-account-contracts";
import {
  roomModelCatalog,
  roomModelPolicy,
  roomModelPolicyReset,
  roomModelPolicySave,
} from "../shared/contracts";
import {
  Difficulty,
  defaultModelPolicy,
  Effort,
  GLOBAL_MODEL_POLICY,
  type ModelPolicyValue,
} from "../shared/model-policy";

type Colors = PluginSurfaceProps["theme"]["colors"];
function Action({
  label,
  onPress,
  colors: c,
  selected,
  disabled,
  accessibleLabel,
}: {
  label: string;
  onPress: () => void;
  colors: Colors;
  selected?: boolean;
  disabled?: boolean;
  accessibleLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibleLabel ?? label}
      accessibilityState={{ selected: Boolean(selected), disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={{
        padding: 9,
        borderWidth: 1,
        borderRadius: 6,
        borderColor: selected ? c.accent : c.border,
        backgroundColor: selected ? c.surface2 : c.surface0,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text style={{ color: c.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

function ProjectClaudeAccount({
  roomId,
  hostId,
  colors: c,
}: {
  roomId: string;
  hostId: string;
  colors: Colors;
}) {
  const read = useRpc(projectClaudeAccountRead);
  const select = useRpc(projectClaudeAccountSelect);
  const queries = useQueryClient();
  const key = ["alliance-project-claude-account", hostId, roomId];
  const state = useQuery({ queryKey: key, queryFn: () => read({ roomId }), retry: false });
  const project = state.data;
  const save = useMutation({
    mutationFn: (account: "inherit" | "5x" | "20x") => {
      if (!project) throw new Error("Load this project's Claude account before saving.");
      return select({ roomId, account, revision: project.revision });
    },
    onSuccess: async (saved) => {
      queries.setQueryData(key, saved);
      await Promise.all([
        queries.invalidateQueries({
          queryKey: ["alliance-model-catalog", hostId, roomId, "project", "claude"],
        }),
        queries.invalidateQueries({ queryKey: ["alliance-claude-accounts", hostId] }),
      ]);
    },
    onError: () => void state.refetch(),
  });
  const hint = { color: c.foregroundMuted, fontSize: 12 };
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.foreground, fontWeight: "600" }}>Claude account</Text>
      <Text style={hint}>
        Applies to every Claude role in this project. Inherit uses the host's role and default account
        settings. Running sessions switch when safely idle.
      </Text>
      {state.isPending && <Text style={hint}>Loading Claude account…</Text>}
      {project && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {(["inherit", "5x", "20x"] as const).map((account) => {
            const available = account === "inherit" || project.accounts.includes(account);
            return (
              <Action
                key={account}
                label={
                  account === "inherit"
                    ? "Inherit"
                    : `Claude ${account}${available ? "" : " · not provisioned"}`
                }
                colors={c}
                selected={project.account === account}
                disabled={save.isPending || !available || project.account === account}
                onPress={() => save.mutate(account)}
              />
            );
          })}
        </View>
      )}
      {(save.error ?? state.error) && (
        <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 12 }}>
          {(save.error ?? state.error)?.message}
        </Text>
      )}
      {state.isError && <Action label="Retry" colors={c} onPress={() => void state.refetch()} />}
    </View>
  );
}

function Editor({
  roomId,
  targetId,
  initial,
  revision,
  saved,
  colors: c,
  hostId,
  onSaved,
  reload,
}: {
  roomId: string;
  targetId: string;
  initial: ModelPolicyValue;
  revision: number;
  saved: boolean;
  colors: Colors;
  hostId: string;
  onSaved: () => void;
  reload: () => void;
}) {
  const [policy, setPolicy] = useState(initial);
  const [harness, setHarness] = useState<"codex" | "claude" | "pi" | "agy">("codex");
  const [role, setRole] = useState<"peer" | "lens">("peer");
  const [model, setModel] = useState("");
  const [efforts, setEfforts] = useState<string[]>([]);
  const catalogRpc = useRpc(roomModelCatalog);
  const saveRpc = useRpc(roomModelPolicySave);
  const resetRpc = useRpc(roomModelPolicyReset);
  const scope = targetId === GLOBAL_MODEL_POLICY ? "global" : "project";
  const catalog = useQuery({
    queryKey: ["alliance-model-catalog", hostId, roomId, scope, harness, role],
    queryFn: () => catalogRpc({ roomId, harness, role, scope }),
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => saveRpc({ roomId: targetId, revision, policy }),
    onSuccess: onSaved,
  });
  const reset = useMutation({
    mutationFn: () => resetRpc({ roomId: targetId, revision }),
    onSuccess: onSaved,
  });
  const busy = save.isPending || reset.isPending;
  const hint = { color: c.foregroundMuted, fontSize: 12 };
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };
  const picked = catalog.data?.models.find((item) => item.id === model);
  const update = (index: number, change: Partial<ModelPolicyValue["routes"][number]>) =>
    setPolicy({
      ...policy,
      routes: policy.routes.map((route, i) => (i === index ? { ...route, ...change } : route)),
    });
  // This role's routes in order, with their index in policy.routes.
  const ordered = policy.routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => route.role === role)
    .sort((a, b) => a.route.priority - b.route.priority || a.index - b.index);
  // Renumber this role 1..n in the given order, leaving the other role untouched.
  const renumber = (order: number[]) =>
    setPolicy({
      ...policy,
      routes: policy.routes.map((route, i) =>
        order.includes(i) ? { ...route, priority: order.indexOf(i) + 1 } : route,
      ),
    });
  const move = (position: number, offset: -1 | 1) => {
    const order = ordered.map(({ index }) => index);
    [order[position], order[position + offset]] = [order[position + offset], order[position]];
    renumber(order);
  };
  return (
    <View style={{ gap: 14 }}>
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
        HQ / Supervisor / Lead · defaults
      </Text>
      <Text style={hint}>
        Default to GPT-6.1 Sol, Claude Sonnet 5.5 or AGY Gemini 4 Argon medium. Select Astra/Opus explicitly
        when the task warrants it. Owners can choose any live-catalog model, but AGY runs only Gemini models
        for every role. This effort is preferred when omitted.
      </Text>
      <View style={row}>
        {Effort.options.map((effort) => (
          <Action
            key={effort}
            label={`Owner ${effort}`}
            colors={c}
            selected={policy.leadEffort === effort}
            disabled={save.isPending}
            onPress={() => setPolicy({ ...policy, leadEffort: effort })}
          />
        ))}
      </View>
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
        Peer / Lens · allowed models, first choice first
      </Text>
      <Text style={hint}>
        Peer and Lens have separate lists. Number 1 is the first choice; agents move down the list when a
        route is unavailable or unsuited. Only listed harness/model/effort routes can be launched for that
        role. A route can be limited to some difficulties. HQ/Supervisor/Lead models remain independent.
      </Text>
      <Text style={hint}>
        {saved
          ? `Saved override (revision ${revision}).`
          : "Inherited defaults. Saving creates an override at the selected scope."}
      </Text>
      <View style={row}>
        {(["peer", "lens"] as const).map((value) => (
          <Action
            key={value}
            label={value === "peer" ? "Peer list" : "Lens list"}
            colors={c}
            selected={role === value}
            onPress={() => {
              setRole(value);
              setModel("");
              setEfforts([]);
            }}
          />
        ))}
      </View>
      <Text style={hint}>
        Difficulties: routine = bounded change, easy check; standard = known constraints; complex =
        cross-component or uncertain diagnosis; frontier = high ambiguity or failed cheaper attempts.
      </Text>
      {ordered.map(({ route, index }, position) => (
        <View
          key={`${route.role}/${route.harness}/${route.model}/${route.effort}`}
          style={{ borderWidth: 1, borderColor: c.border, padding: 12, borderRadius: 7, gap: 8 }}
        >
          <Text selectable style={{ color: c.foreground, fontSize: 13 }}>
            {route.model} · {route.effort}
          </Text>
          <Text style={hint}>
            {position + 1}. {route.harness} · {route.role}
          </Text>
          <View style={row}>
            <Action
              label="↑ Earlier"
              accessibleLabel={`Prefer ${route.model} ${route.effort}`}
              colors={c}
              disabled={busy || position === 0}
              onPress={() => move(position, -1)}
            />
            <Action
              label="↓ Later"
              accessibleLabel={`Lower priority ${route.model} ${route.effort}`}
              colors={c}
              disabled={busy || position === ordered.length - 1}
              onPress={() => move(position, 1)}
            />
            <Action
              label="Remove"
              accessibleLabel={`Remove ${route.model} ${route.effort}`}
              colors={c}
              disabled={busy}
              onPress={() => setPolicy({ ...policy, routes: policy.routes.filter((_, i) => i !== index) })}
            />
          </View>
          <View style={row}>
            {Difficulty.options.map((tier) => (
              <Action
                key={tier}
                label={tier}
                accessibleLabel={`${route.model} ${route.effort}: ${tier}`}
                colors={c}
                selected={route.difficulties.includes(tier)}
                disabled={busy || (route.difficulties.length === 1 && route.difficulties.includes(tier))}
                onPress={() =>
                  update(index, {
                    difficulties: route.difficulties.includes(tier)
                      ? route.difficulties.filter((item) => item !== tier)
                      : [...route.difficulties, tier],
                  })
                }
              />
            ))}
          </View>
        </View>
      ))}
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
        Add to the {role} list from the live catalog
      </Text>
      <View style={row}>
        {(["codex", "claude", "pi", "agy"] as const).map((value) => (
          <Action
            key={value}
            label={value}
            colors={c}
            selected={harness === value}
            onPress={() => {
              setHarness(value);
              setModel("");
              setEfforts([]);
            }}
          />
        ))}
      </View>
      {catalog.isPending && <Text style={hint}>Loading provider models…</Text>}
      {catalog.error && (
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>
            {catalog.error.message}
          </Text>
          <Action label="Retry catalog" colors={c} onPress={() => void catalog.refetch()} />
        </View>
      )}
      <ScrollView style={{ maxHeight: 180 }} contentContainerStyle={{ gap: 5 }}>
        {catalog.data?.models.map((item) => (
          <Action
            key={item.id}
            label={item.id}
            colors={c}
            selected={model === item.id}
            onPress={() => {
              setModel(item.id);
              setEfforts([]);
            }}
          />
        ))}
      </ScrollView>
      {picked && (
        <View style={row}>
          {picked.efforts
            .filter((value) => Effort.safeParse(value).success)
            .map((value) => (
              <Action
                key={value}
                label={value}
                colors={c}
                selected={efforts.includes(value)}
                disabled={busy}
                onPress={() =>
                  setEfforts(
                    efforts.includes(value) ? efforts.filter((v) => v !== value) : [...efforts, value],
                  )
                }
              />
            ))}
          <Action
            label={`Add selected (${efforts.length})`}
            colors={c}
            disabled={busy || !efforts.length}
            onPress={() => {
              const last = Math.max(
                0,
                ...policy.routes.filter((r) => r.role === role).map((r) => r.priority),
              );
              const additions = picked.efforts.filter(
                (e) =>
                  efforts.includes(e) &&
                  !policy.routes.some(
                    (r) => r.role === role && r.harness === harness && r.model === model && r.effort === e,
                  ),
              );
              setPolicy({
                ...policy,
                routes: [
                  ...policy.routes,
                  ...additions.map((e, i) => ({
                    role,
                    harness,
                    model,
                    effort: Effort.parse(e),
                    priority: Math.min(99, last + i + 1),
                    difficulties: [...Difficulty.options],
                  })),
                ],
              });
              setEfforts([]);
            }}
          />
        </View>
      )}
      {picked && !picked.efforts.some((value) => Effort.safeParse(value).success) && (
        <Text style={hint}>This provider reports no supported effort options for this model.</Text>
      )}
      <Text style={hint}>
        Saved choices are checked against the target role's catalog at launch. No silent model or effort
        substitution. Changes affect new launches; existing native sessions and in-session model changes are
        outside this launch gate.
      </Text>
      {(save.error ?? reset.error) && (
        <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>
          {(save.error ?? reset.error)?.message}
        </Text>
      )}
      <View style={row}>
        <Action
          label={save.isPending ? "Saving…" : "Save model settings"}
          colors={c}
          disabled={busy}
          onPress={() => save.mutate()}
        />
        <Action
          label="Reset defaults"
          colors={c}
          disabled={busy}
          onPress={() => setPolicy(defaultModelPolicy())}
        />
        <Action label="Reload saved settings" colors={c} disabled={busy} onPress={reload} />
        {saved && (
          <Action
            label={
              reset.isPending
                ? "Resetting…"
                : targetId === GLOBAL_MODEL_POLICY
                  ? "Follow release defaults"
                  : "Inherit global settings"
            }
            accessibleLabel="Remove this override and inherit defaults"
            colors={c}
            disabled={busy}
            onPress={() => reset.mutate()}
          />
        )}
      </View>
    </View>
  );
}

export function ModelSettings({
  roomId,
  title,
  theme,
  hostId,
  onClose,
}: {
  roomId: string;
  title: string;
  theme: PluginSurfaceProps["theme"];
  hostId: string;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"project" | "global">("project");
  const targetId = scope === "global" ? GLOBAL_MODEL_POLICY : roomId;
  const read = useRpc(roomModelPolicy);
  const policy = useQuery({
    queryKey: ["alliance-model-policy", hostId, targetId],
    queryFn: () => read({ roomId: targetId }),
    refetchOnWindowFocus: false,
  });
  const [generation, setGeneration] = useState(0);
  return (
    <Modal
      title={`Models · ${title}`}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Content contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Action
            label="This project"
            colors={theme.colors}
            selected={scope === "project"}
            onPress={() => setScope("project")}
          />
          <Action
            label="Global · this daemon"
            colors={theme.colors}
            selected={scope === "global"}
            onPress={() => setScope("global")}
          />
        </View>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Global settings apply to all inheriting projects on this machine. Project overrides take precedence.
        </Text>
        {scope === "project" && (
          <ProjectClaudeAccount roomId={roomId} hostId={hostId} colors={theme.colors} />
        )}
        {policy.isPending && (
          <Text style={{ color: theme.colors.foregroundMuted }}>Loading room policy…</Text>
        )}
        {policy.error && (
          <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
            {policy.error.message}
          </Text>
        )}
        {policy.data && (
          <Editor
            key={`${targetId}/${policy.data.revision}/${generation}`}
            roomId={roomId}
            targetId={targetId}
            initial={policy.data.policy}
            revision={policy.data.revision}
            saved={policy.data.saved}
            colors={theme.colors}
            hostId={hostId}
            onSaved={() => {
              void policy.refetch();
              onClose();
            }}
            reload={() => {
              void policy.refetch().then(() => setGeneration((value) => value + 1));
            }}
          />
        )}
      </Modal.Content>
    </Modal>
  );
}
