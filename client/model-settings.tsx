import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { roomModelCatalog, roomModelPolicy, roomModelPolicySave } from "../shared/contracts";
import {
  Difficulty,
  defaultModelPolicy,
  Effort,
  type ModelPolicyValue,
  type TaskDifficulty,
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

function Editor({
  roomId,
  initial,
  revision,
  colors: c,
  hostId,
  onSaved,
  reload,
}: {
  roomId: string;
  initial: ModelPolicyValue;
  revision: number;
  colors: Colors;
  hostId: string;
  onSaved: () => void;
  reload: () => void;
}) {
  const [policy, setPolicy] = useState(initial);
  const [difficulty, setDifficulty] = useState<TaskDifficulty>("standard");
  const [harness, setHarness] = useState<"codex" | "claude" | "pi" | "agy">("codex");
  const [role, setRole] = useState<"peer" | "lens">("peer");
  const [model, setModel] = useState("");
  const catalogRpc = useRpc(roomModelCatalog);
  const saveRpc = useRpc(roomModelPolicySave);
  const catalog = useQuery({
    queryKey: ["alliance-model-catalog", hostId, roomId, harness, role],
    queryFn: () => catalogRpc({ roomId, harness, role }),
    retry: false,
  });
  const save = useMutation({ mutationFn: () => saveRpc({ roomId, revision, policy }), onSuccess: onSaved });
  const hint = { color: c.foregroundMuted, fontSize: 12 };
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };
  const picked = catalog.data?.models.find((item) => item.id === model);
  const update = (index: number, change: Partial<ModelPolicyValue["routes"][number]>) =>
    setPolicy({
      ...policy,
      routes: policy.routes.map((route, i) => (i === index ? { ...route, ...change } : route)),
    });
  return (
    <View style={{ gap: 14 }}>
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
        HQ / Supervisor / Lead · defaults
      </Text>
      <Text style={hint}>
        Default to GPT-6.1 Sol or Claude Sonnet 5.5. Select Astra/Opus explicitly when the task warrants it.
        Owners can choose any live-catalog model. This effort is preferred when omitted.
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
        Peer & Lens · allowed models and priorities
      </Text>
      <Text style={hint}>
        Lower numbers are preferred. Lead assesses difficulty and makes the final selection; Supervisor/HQ can
        intervene. Bands guide native delegation; the combined allowlist is enforced at creation.
        HQ/Supervisor models remain independent.
      </Text>
      <View style={row}>
        {Difficulty.options.map((tier) => (
          <Action
            key={tier}
            label={tier}
            colors={c}
            selected={difficulty === tier}
            onPress={() => setDifficulty(tier)}
          />
        ))}
      </View>
      <Text style={hint}>
        {
          {
            routine: "Clear, bounded changes with easy verification.",
            standard: "Implementation and debugging with known constraints.",
            complex: "Cross-component work, uncertain diagnosis or demanding review.",
            frontier: "High ambiguity, architectural risk or failed lower-cost attempts.",
          }[difficulty]
        }
      </Text>
      {policy.routes.map((route, index) =>
        !route.difficulties.includes(difficulty) ? null : (
          <View
            key={`${route.harness}/${route.model}/${route.effort}`}
            style={{ borderWidth: 1, borderColor: c.border, padding: 12, borderRadius: 7, gap: 8 }}
          >
            <Text selectable style={{ color: c.foreground, fontSize: 13 }}>
              {route.model} · {route.effort}
            </Text>
            <Text style={hint}>
              {route.harness} · priority {route.priority}
            </Text>
            <View style={row}>
              <Action
                label="↑ Priority"
                accessibleLabel={`Prefer ${route.model} ${route.effort}`}
                colors={c}
                disabled={save.isPending || route.priority === 1}
                onPress={() => update(index, { priority: route.priority - 1 })}
              />
              <Action
                label="↓ Priority"
                accessibleLabel={`Lower priority ${route.model} ${route.effort}`}
                colors={c}
                disabled={save.isPending || route.priority === 99}
                onPress={() => update(index, { priority: route.priority + 1 })}
              />
              <Action
                label="Remove"
                accessibleLabel={`Remove ${route.model} ${route.effort}`}
                colors={c}
                disabled={save.isPending}
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
                  disabled={
                    save.isPending || (route.difficulties.length === 1 && route.difficulties.includes(tier))
                  }
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
        ),
      )}
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>Add from live catalog</Text>
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
            }}
          />
        ))}
        {(["peer", "lens"] as const).map((value) => (
          <Action
            key={value}
            label={`${value} catalog`}
            colors={c}
            selected={role === value}
            onPress={() => {
              setRole(value);
              setModel("");
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
            onPress={() => setModel(item.id)}
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
                label={`Add ${value}`}
                colors={c}
                disabled={save.isPending}
                onPress={() => {
                  const existing = policy.routes.findIndex(
                    (route) => route.harness === harness && route.model === model && route.effort === value,
                  );
                  if (existing >= 0)
                    update(existing, {
                      difficulties: Array.from(
                        new Set([...policy.routes[existing].difficulties, difficulty]),
                      ),
                    });
                  else
                    setPolicy({
                      ...policy,
                      routes: [
                        ...policy.routes,
                        {
                          harness,
                          model,
                          effort: Effort.parse(value),
                          priority: 3,
                          difficulties: [difficulty],
                        },
                      ],
                    });
                }}
              />
            ))}
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
      {save.error && (
        <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>
          {save.error.message}
        </Text>
      )}
      <View style={row}>
        <Action
          label={save.isPending ? "Saving…" : "Save model settings"}
          colors={c}
          disabled={save.isPending}
          onPress={() => save.mutate()}
        />
        <Action
          label="Reset defaults"
          colors={c}
          disabled={save.isPending}
          onPress={() => setPolicy(defaultModelPolicy())}
        />
        <Action label="Reload saved settings" colors={c} disabled={save.isPending} onPress={reload} />
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
  const read = useRpc(roomModelPolicy);
  const policy = useQuery({
    queryKey: ["alliance-model-policy", hostId, roomId],
    queryFn: () => read({ roomId }),
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
            key={`${policy.data.revision}/${generation}`}
            roomId={roomId}
            initial={policy.data.policy}
            revision={policy.data.revision}
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
