import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  Harness,
  memberDisposition,
  memberLaunch,
  memberResume,
  profileStatus,
  Role,
  roomCreate,
  roomList,
} from "../shared/contracts";

export function Rooms({ theme, layout, navigation }: PluginSurfaceProps) {
  const c = theme.colors;
  const paseo = usePaseo();
  const cache = useQueryClient();
  const list = useRpc(roomList),
    create = useRpc(roomCreate),
    launch = useRpc(memberLaunch),
    resume = useRpc(memberResume),
    dispose = useRpc(memberDisposition),
    profiles = useRpc(profileStatus);
  const data = useQuery({ queryKey: ["alliance-rooms"], queryFn: () => list({}) });
  const profile = useQuery({ queryKey: ["alliance-profiles"], queryFn: () => profiles({}) });
  const [selected, select] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState(""),
    [cwd, setCwd] = useState(""),
    [mission, setMission] = useState("");
  const [role, setRole] = useState<"hq" | "supervisor" | "lead" | "peer" | "lens">("supervisor");
  const [harness, setHarness] = useState<"codex" | "claude" | "pi">("codex");
  const [model, setModel] = useState(""),
    [prompt, setPrompt] = useState("");
  const [launchKey, setLaunchKey] = useState(() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [review, setReview] = useState<string | null>(null),
    [candidate, setCandidate] = useState(""),
    [evidence, setEvidence] = useState("");
  const [resumeId, setResumeId] = useState<string | null>(null),
    [resumePrompt, setResumePrompt] = useState("");
  const room = data.data?.rooms.find((item) => item.id === selected) ?? data.data?.rooms[0];
  const members = data.data?.members.filter((item) => item.roomId === room?.id) ?? [];
  const models = useQuery({
    queryKey: ["alliance-models", harness, role],
    queryFn: () => paseo.providers.listModels(`alliance-${harness}-${role}`),
    enabled: Boolean(room),
  });
  useEffect(() => {
    const unsubscribe = paseo.agents.subscribe(() => {
      void cache.invalidateQueries({ queryKey: ["alliance-rooms"] });
    });
    return unsubscribe;
  }, [paseo, cache]);
  const refresh = () => cache.invalidateQueries({ queryKey: ["alliance-rooms"] });
  const newRoom = useMutation({
    mutationFn: () => create({ title, cwd, mission }),
    onSuccess: (result) => {
      select(result.id);
      setCreating(false);
      setTitle("");
      setCwd("");
      setMission("");
      void refresh();
    },
  });
  const newMember = useMutation({
    mutationFn: () => {
      if (!room) throw new Error("Select a room");
      return launch({ roomId: room.id, key: launchKey, role, harness, model, prompt });
    },
    onSuccess: (result) => {
      setPrompt("");
      setLaunchKey(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
      void refresh();
      navigation?.openAgent({ agentId: result.agentId });
    },
  });
  const continueMember = useMutation({
    mutationFn: () => {
      if (!resumeId) throw new Error("Select an agent to resume");
      return resume({ agentId: resumeId, prompt: resumePrompt });
    },
    onSuccess: () => {
      setResumeId(null);
      setResumePrompt("");
      void refresh();
    },
  });
  const decision = useMutation({
    mutationFn: (value: "accepted" | "rejected") => {
      if (!review) throw new Error("Select a candidate to review");
      return dispose({ agentId: review, decision: value, candidate, evidence });
    },
    onSuccess: () => {
      setReview(null);
      setCandidate("");
      setEvidence("");
      void refresh();
    },
  });
  const inputStyle = {
    color: c.foreground,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    fontSize: 14,
  };
  const label = { color: c.foregroundMuted, fontSize: 12, marginBottom: 6 };
  const button = (text: string, onPress: () => void, disabled = false, primary = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: primary ? c.accent : c.surface1,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text style={{ color: primary ? c.accentForeground : c.foreground, fontSize: 13 }}>{text}</Text>
    </Pressable>
  );
  const error =
    data.error || newRoom.error || newMember.error || continueMember.error || decision.error || profile.error;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 16 : 28,
        gap: 24,
        maxWidth: 1180,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.foreground, fontSize: 25, fontWeight: "600" }}>Alliance Work</Text>
          <Text style={{ color: c.foregroundMuted, marginTop: 5 }}>
            Shared outcomes. Independent judgment.
          </Text>
        </View>
        {button(creating ? "Close form" : "New room", () => setCreating(!creating))}
      </View>
      {error && (
        <View
          accessibilityRole="alert"
          style={{ padding: 14, borderColor: c.border, borderWidth: 1, gap: 10 }}
        >
          <Text style={{ color: c.foreground }}>{error.message}</Text>
          {button("Refresh", () => {
            void data.refetch();
            void profile.refetch();
          })}
        </View>
      )}
      {creating && (
        <View style={{ gap: 12, paddingBottom: 20, borderBottomWidth: 1, borderColor: c.border }}>
          <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}>
            Give the room an outcome
          </Text>
          <TextInput
            accessibilityLabel="Room title"
            placeholder="Room title"
            placeholderTextColor={c.foregroundMuted}
            style={inputStyle}
            value={title}
            onChangeText={setTitle}
          />
          <TextInput
            accessibilityLabel="Project directory"
            placeholder="Absolute project directory"
            placeholderTextColor={c.foregroundMuted}
            style={inputStyle}
            value={cwd}
            onChangeText={setCwd}
            autoCapitalize="none"
          />
          <TextInput
            accessibilityLabel="Room mission"
            placeholder="What should this room achieve?"
            placeholderTextColor={c.foregroundMuted}
            style={[inputStyle, { minHeight: 100, textAlignVertical: "top" }]}
            multiline
            value={mission}
            onChangeText={setMission}
          />
          <View style={{ alignItems: "flex-start" }}>
            {button(
              newRoom.isPending ? "Creating…" : "Create room",
              () => newRoom.mutate(),
              newRoom.isPending || !title.trim() || !cwd.trim() || !mission.trim(),
              true,
            )}
          </View>
        </View>
      )}
      {data.isPending && <Text style={{ color: c.foregroundMuted }}>Loading rooms…</Text>}
      {!data.isPending && !room && !creating && (
        <View style={{ paddingVertical: 48, gap: 12 }}>
          <Text style={{ color: c.foreground, fontSize: 20 }}>Start with one clear outcome.</Text>
          <Text style={{ color: c.foregroundMuted, maxWidth: 540 }}>
            Create a room for a project. Bring in a Supervisor, work directly with a Lead, or assign a focused
            task to a Peer. The team can grow when the work calls for it.
          </Text>
          <View style={{ alignItems: "flex-start" }}>
            {button("Create the first room", () => setCreating(true), false, true)}
          </View>
        </View>
      )}
      {room && (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {data.data?.rooms.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => select(item.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: item.id === room.id }}
                style={{
                  paddingVertical: 8,
                  paddingHorizontal: 12,
                  borderBottomWidth: item.id === room.id ? 2 : 0,
                  borderColor: c.accent,
                }}
              >
                <Text style={{ color: item.id === room.id ? c.foreground : c.foregroundMuted }}>
                  {item.title}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={{ gap: 10 }}>
            <Text style={{ color: c.foreground, fontSize: 20, fontWeight: "600" }}>{room.title}</Text>
            <Text selectable style={{ color: c.foreground, lineHeight: 22 }}>
              {room.mission}
            </Text>
            <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>
              {room.cwd}
            </Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>Agents & work</Text>
            {button(
              data.isFetching ? "Refreshing…" : "Refresh",
              () => {
                void data.refetch();
              },
              data.isFetching,
            )}
          </View>
          {!members.length && (
            <Text style={{ color: c.foregroundMuted }}>
              No agents yet. Choose a role and give it an assignment below.
            </Text>
          )}
          {members.map((member) => (
            <View
              key={member.id}
              style={{ borderTopWidth: 1, borderColor: c.border, paddingTop: 14, gap: 10 }}
            >
              <View
                style={{
                  flexDirection: layout.compact ? "column" : "row",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={{ color: c.foreground, fontWeight: "600", fontSize: 15 }}>
                    {member.role} · {member.status}
                  </Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    {member.provider} · acceptance: {member.decision}
                  </Text>
                  <Text selectable style={{ color: c.foregroundMuted, fontSize: 11 }}>
                    {member.id}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {navigation && button("Open chat", () => navigation.openAgent({ agentId: member.id }))}
                  {button(
                    "Resume",
                    () => {
                      setResumeId(member.id);
                      setResumePrompt(
                        "Continue the existing assignment. Reconcile the latest artifacts and unfinished work first.",
                      );
                    },
                    ["running", "starting", "initializing"].includes(member.status),
                  )}
                  {button("Disposition", () => setReview(member.id))}
                </View>
              </View>
              {member.lastOutcome && (
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                  Last recorded turn: {member.lastOutcome}. Acceptance requires a separate disposition.
                </Text>
              )}
              {member.error && <Text style={{ color: c.foreground }}>{member.error}</Text>}
              {member.resultPath && (
                <Text selectable style={{ color: c.foregroundMuted, fontSize: 11 }}>
                  Result: {member.resultPath}
                </Text>
              )}
              {resumeId === member.id && (
                <View style={{ gap: 8 }}>
                  <TextInput
                    accessibilityLabel="Resume instructions"
                    multiline
                    value={resumePrompt}
                    onChangeText={setResumePrompt}
                    style={[inputStyle, { minHeight: 80 }]}
                  />
                  {button(
                    "Continue assignment",
                    () => continueMember.mutate(),
                    continueMember.isPending || !resumePrompt.trim(),
                    true,
                  )}
                </View>
              )}
              {review === member.id && (
                <View style={{ gap: 8 }}>
                  <TextInput
                    accessibilityLabel="Candidate identity"
                    placeholder="Candidate SHA or immutable artifact"
                    placeholderTextColor={c.foregroundMuted}
                    value={candidate}
                    onChangeText={setCandidate}
                    style={inputStyle}
                  />
                  <TextInput
                    accessibilityLabel="Disposition evidence"
                    placeholder="What was verified? What remains?"
                    placeholderTextColor={c.foregroundMuted}
                    multiline
                    value={evidence}
                    onChangeText={setEvidence}
                    style={[inputStyle, { minHeight: 80 }]}
                  />
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    {button(
                      "Accept candidate",
                      () => decision.mutate("accepted"),
                      decision.isPending || !candidate.trim() || !evidence.trim(),
                    )}
                    {button(
                      "Reject candidate",
                      () => decision.mutate("rejected"),
                      decision.isPending || !candidate.trim() || !evidence.trim(),
                    )}
                    {button("Cancel", () => setReview(null))}
                  </View>
                </View>
              )}
            </View>
          ))}
          <View style={{ gap: 12, borderTopWidth: 1, borderColor: c.border, paddingTop: 24 }}>
            <Text style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>Start an assignment</Text>
            <View>
              <Text style={label}>Responsibility</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {Role.options.map((item) => (
                  <View key={item}>{button(item, () => setRole(item), false, item === role)}</View>
                ))}
              </View>
            </View>
            <View>
              <Text style={label}>Harness</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {Harness.options.map((item) => (
                  <View key={item}>
                    {button(
                      item,
                      () => {
                        if (item !== harness) setModel("");
                        setHarness(item);
                      },
                      false,
                      item === harness,
                    )}
                  </View>
                ))}
              </View>
            </View>
            <View>
              <Text style={label}>Model</Text>
              <TextInput
                accessibilityLabel="Model ID"
                value={model}
                onChangeText={setModel}
                autoCapitalize="none"
                placeholder="Choose below or enter a model ID"
                placeholderTextColor={c.foregroundMuted}
                style={inputStyle}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                {models.data?.models?.map((item) => (
                  <View key={item.id}>
                    {button(item.label || item.id, () => setModel(item.id), false, item.id === model)}
                  </View>
                ))}
              </View>
              {models.isPending && <Text style={label}>Reading the provider catalog…</Text>}
              {models.error && <Text style={label}>{models.error.message}</Text>}
            </View>
            <TextInput
              accessibilityLabel="Assignment"
              placeholder="Outcome, scope and what will count as done…"
              placeholderTextColor={c.foregroundMuted}
              multiline
              value={prompt}
              onChangeText={setPrompt}
              style={[inputStyle, { minHeight: 120, textAlignVertical: "top" }]}
            />
            <View style={{ alignItems: "flex-start" }}>
              {button(
                newMember.isPending ? "Starting…" : `Start ${role}`,
                () => newMember.mutate(),
                newMember.isPending || !model.trim() || !prompt.trim(),
                true,
              )}
            </View>
            <Text style={label}>
              Uses the role’s independent home. Configure shared Codex auth or sign in to this role before
              starting.
            </Text>
          </View>
        </>
      )}
      {profile.data && (
        <Text selectable style={{ color: c.foregroundMuted, fontSize: 11 }}>
          Alliance home: {profile.data.home} · {profile.data.profiles.length} role profiles
        </Text>
      )}
    </ScrollView>
  );
}
