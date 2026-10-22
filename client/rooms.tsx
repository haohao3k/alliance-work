import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { directoryList, roomCreate, roomList } from "../shared/contracts";
import { activityState, relativeTime } from "../shared/monitor";
import { acceptanceLabel } from "../shared/operations";
import { ModelSettings } from "./model-settings";

type Props = PluginSurfaceProps;
type Colors = Props["theme"]["colors"];
type Filter = "all" | "working" | "attention" | "idle";

function Button({
  label,
  icon,
  onPress,
  colors: c,
  disabled,
  selected,
}: {
  label: string;
  icon?: string;
  onPress: () => void;
  colors: Colors;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled), selected: Boolean(selected) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 36,
        paddingHorizontal: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? c.accent : c.border,
        backgroundColor: selected || pressed ? c.surface2 : c.surface0,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      {icon && <Icon name={icon} size={14} color={c.foregroundMuted} />}
      <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

function ProjectPicker({
  theme,
  host,
  onClose,
  onCreated,
}: {
  theme: Props["theme"];
  host: Props["host"];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const c = theme.colors;
  const suggest = useRpc(directoryList);
  const create = useRpc(roomCreate);
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(path), 200);
    return () => clearTimeout(timer);
  }, [path]);
  const folders = useQuery({
    queryKey: ["alliance-directories", host.id, query],
    queryFn: () => suggest({ query }),
    retry: false,
  });
  const add = useMutation({
    mutationFn: () => create({ cwd: folders.data?.current ?? "" }),
    onSuccess: (room) => onCreated(room.id),
  });
  const pendingPath = path !== query || folders.isFetching;
  return (
    <Modal
      title="Add project"
      icon={<Icon name="FolderPlus" size={18} color={c.foregroundMuted} />}
      open
      onOpenChange={(open) => {
        if (!open && !add.isPending) onClose();
      }}
    >
      <Modal.Content contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="Server" size={14} color={c.foregroundMuted} />
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{host.label}</Text>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 8,
            paddingHorizontal: 12,
          }}
        >
          <Icon name="FolderSearch" size={16} color={c.foregroundMuted} />
          <TextInput
            autoFocus
            accessibilityLabel="Project path"
            placeholder="Search folders…"
            placeholderTextColor={c.foregroundMuted}
            value={path}
            onChangeText={setPath}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, minWidth: 0, padding: 12, fontSize: 14, color: c.foreground }}
          />
        </View>
        <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: "hidden" }}>
          {query && folders.data && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Parent folder"
              onPress={() => setPath(`${folders.data?.parent}/`)}
              style={{
                flexDirection: "row",
                gap: 10,
                alignItems: "center",
                padding: 12,
                backgroundColor: c.surface1,
              }}
            >
              <Icon name="ArrowUp" size={16} color={c.foregroundMuted} />
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Parent folder</Text>
            </Pressable>
          )}
          <ScrollView style={{ maxHeight: 270 }} keyboardShouldPersistTaps="handled">
            {!pendingPath &&
              folders.data?.paths.map((folder) => (
                <Pressable
                  key={folder}
                  accessibilityRole="button"
                  accessibilityLabel={`Browse ${folder}`}
                  onPress={() => setPath(`${folder}/`)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    gap: 10,
                    alignItems: "center",
                    padding: 12,
                    backgroundColor: pressed ? c.surface2 : c.surface0,
                  })}
                >
                  <Icon name="Folder" size={16} color={c.foregroundMuted} />
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13 }}>
                      {folder.split("/").filter(Boolean).at(-1) || "/"}
                    </Text>
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="head"
                      style={{ color: c.foregroundMuted, fontSize: 11 }}
                    >
                      {folder}
                    </Text>
                  </View>
                  <Icon name="ChevronRight" size={14} color={c.foregroundMuted} />
                </Pressable>
              ))}
            {(pendingPath || !folders.data?.paths.length) && (
              <Text style={{ padding: 14, color: c.foregroundMuted, fontSize: 12 }}>
                {pendingPath ? "Loading…" : folders.error ? "Folder unavailable" : "No subfolders"}
              </Text>
            )}
          </ScrollView>
        </View>
        {(folders.error || add.error) && (
          <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 12 }}>
            {(folders.error || add.error)?.message}
          </Text>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text
            numberOfLines={1}
            ellipsizeMode="head"
            style={{ flex: 1, color: c.foregroundMuted, fontSize: 12 }}
          >
            {!pendingPath ? folders.data?.current : ""}
          </Text>
          <Button
            label={add.isPending ? "Adding…" : "Add project"}
            icon="Plus"
            colors={c}
            onPress={() => add.mutate()}
            disabled={add.isPending || pendingPath || !folders.data?.current}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function Rooms({ theme, host, layout, navigation }: Props) {
  const c = theme.colors;
  const paseo = usePaseo();
  const cache = useQueryClient();
  const list = useRpc(roomList);
  const queryKey = ["alliance-rooms", host.id];
  const data = useQuery({ queryKey, queryFn: () => list({}), refetchInterval: 5000 });
  const [project, setProject] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [modelRoom, setModelRoom] = useState<{ id: string; title: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    const unsubscribe = paseo.agents.subscribe(() => {
      void cache.invalidateQueries({ queryKey: ["alliance-rooms", host.id] });
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [paseo, cache, host.id]);

  const rooms = data.data?.rooms ?? [];
  const jobs = data.data?.jobs ?? [];
  const wakeups = data.data?.wakeups ?? [];
  const members = (data.data?.members ?? []).filter((member) => archived || !member.archived);
  const counts = {
    all: members.length,
    working: members.filter((member) => activityState(member).group === "working").length,
    attention: members.filter((member) => activityState(member).group === "attention").length,
    idle: members.filter((member) => activityState(member).group === "idle").length,
  };
  const needle = search.trim().toLowerCase();
  const groups = rooms
    .filter((room) => !project || project === room.id)
    .map((room) => ({
      room,
      members: members
        .filter(
          (member) =>
            member.roomId === room.id &&
            (filter === "all" || activityState(member).group === filter) &&
            (!needle ||
              `${room.title} ${room.cwd} ${member.title} ${member.role} ${member.model ?? ""}`
                .toLowerCase()
                .includes(needle)),
        )
        .sort((a, b) => activityState(a).order - activityState(b).order || a.title.localeCompare(b.title)),
    }))
    .filter(
      ({ room, members: rows }) =>
        rows.length ||
        (filter === "all" && (!needle || `${room.title} ${room.cwd}`.toLowerCase().includes(needle))),
    );
  const muted = { color: c.foregroundMuted, fontSize: 11 };
  const cell = { color: c.foreground, fontSize: 12 };
  const compact = layout.compact || panelWidth < 780;

  return (
    <View
      onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, backgroundColor: c.surface0 }}
    >
      <ScrollView
        contentContainerStyle={{
          padding: compact ? 14 : 24,
          gap: 18,
          width: "100%",
          maxWidth: 1440,
          alignSelf: "center",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Icon name="Activity" size={21} color={c.accent} />
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={{ color: c.foreground, fontSize: 21, fontWeight: "600" }}>Alliance Work</Text>
            <Text style={muted}>{host.label}</Text>
            {data.data?.wakeupHealth.error && (
              <Text style={{ ...muted, color: c.statusWarning }}>{data.data.wakeupHealth.error}</Text>
            )}
          </View>
          <Button label="Add project" icon="FolderPlus" colors={c} onPress={() => setAdding(true)} />
          {!compact && (
            <Button
              label="Refresh"
              icon="RefreshCw"
              colors={c}
              onPress={() => void data.refetch()}
              disabled={data.isFetching}
            />
          )}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(
            [
              ["all", "Agents"],
              ["working", "Working"],
              ["attention", "Attention"],
              ["idle", "Idle"],
            ] as const
          ).map(([key, label]) => (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`${label}: ${counts[key]}`}
              accessibilityState={{ selected: filter === key }}
              onPress={() => setFilter(key)}
              style={({ pressed }) => ({
                flex: 1,
                minWidth: compact ? 70 : 120,
                padding: compact ? 10 : 14,
                gap: 5,
                borderWidth: 1,
                borderRadius: 8,
                borderColor: filter === key ? c.accent : c.border,
                backgroundColor: pressed ? c.surface2 : c.surface1,
              })}
            >
              <Text
                style={{
                  color:
                    key === "attention" && counts[key]
                      ? c.statusWarning
                      : key === "working"
                        ? c.statusSuccess
                        : c.foreground,
                  fontSize: 24,
                  fontWeight: "600",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {data.data ? counts[key] : "—"}
              </Text>
              <Text style={muted}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 6,
              paddingHorizontal: 10,
            }}
          >
            <Icon name="Search" size={14} color={c.foregroundMuted} />
            <TextInput
              accessibilityLabel="Filter agents"
              placeholder="Filter agents or projects…"
              placeholderTextColor={c.foregroundMuted}
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ flex: 1, minWidth: 0, minHeight: 36, color: c.foreground, fontSize: 12 }}
            />
          </View>
          <Button label="Archived" colors={c} selected={archived} onPress={() => setArchived(!archived)} />
        </View>
        {rooms.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            <Button
              label="All projects"
              selected={project === null}
              colors={c}
              onPress={() => setProject(null)}
            />
            {rooms.map((room) => (
              <Button
                key={room.id}
                label={room.title}
                selected={project === room.id}
                colors={c}
                onPress={() => setProject(room.id)}
              />
            ))}
          </ScrollView>
        )}
        {data.error && (
          <View style={{ gap: 8 }}>
            <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 12 }}>
              {data.data ? "Update failed · showing last result. " : "Unable to load agents. "}
              {data.error.message}
            </Text>
            <Button label="Retry" colors={c} onPress={() => void data.refetch()} disabled={data.isFetching} />
          </View>
        )}
        {data.isPending && <Text style={muted}>Loading…</Text>}
        {!data.isPending && !data.error && !rooms.length && (
          <View style={{ paddingVertical: 40, alignItems: "center", gap: 10 }}>
            <Icon name="Activity" size={28} color={c.foregroundMuted} />
            <Text style={cell}>No Alliance sessions</Text>
            <Text style={muted}>Start an Alliance profile in any Paseo project.</Text>
          </View>
        )}
        {!!rooms.length && !groups.length && <Text style={muted}>No matching agents</Text>}
        {groups.map(({ room, members: rows }) => (
          <View
            key={room.id}
            style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: "hidden" }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
                paddingHorizontal: 14,
                paddingVertical: 12,
                backgroundColor: c.surface1,
              }}
            >
              <Icon name="Folder" size={15} color={c.foregroundMuted} />
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text numberOfLines={1} style={{ ...cell, fontWeight: "600" }}>
                  {room.title}
                </Text>
                <Text numberOfLines={1} ellipsizeMode="head" selectable style={muted}>
                  {room.cwd}
                </Text>
              </View>
              <Text style={muted}>{rows.length}</Text>
              <Button label="Models" icon="Settings2" colors={c} onPress={() => setModelRoom(room)} />
            </View>
            {(data.data?.obligations ?? [])
              .filter((o) => o.roomId === room.id && o.state === "open")
              .map((o) => (
                <View key={o.key} style={{ padding: 14, gap: 4, backgroundColor: c.surface1 }}>
                  <Text style={cell}>
                    Obligation · {o.key} · {o.blockedOn.length ? "Waiting" : "Conditions recorded"}
                  </Text>
                  <Text
                    selectable
                    style={{
                      ...muted,
                      color: o.ownerStatus === "needs-owner" ? c.statusWarning : c.foregroundMuted,
                    }}
                  >
                    Owner: {o.ownerLabel} · {o.ownerStatus} · revision {o.revision}
                  </Text>
                  <Text selectable style={muted}>
                    {o.nextAction}
                  </Text>
                  {o.blockedOn.map((reason) => (
                    <Text key={reason} selectable style={muted}>
                      {reason}
                    </Text>
                  ))}
                </View>
              ))}
            {wakeups
              .filter(
                (w) => w.roomId === room.id && !["acknowledged", "canceled", "expired"].includes(w.state),
              )
              .map((w) => (
                <View key={w.key} style={{ padding: 14, gap: 4, backgroundColor: c.surface1 }}>
                  <Text style={cell}>
                    Wakeup · {w.state} · {w.reason}
                  </Text>
                  <Text selectable style={muted}>
                    Owner: {members.find((m) => m.id === w.ownerId)?.title ?? w.ownerId} ·{" "}
                    {w.delivery === "pull" ? "Read at next task boundary" : "Idle delivery enabled"}
                  </Text>
                  <Text selectable style={muted}>
                    {w.key} · revision {w.revision}
                    {w.note ? ` · ${w.note}` : ""}
                  </Text>
                </View>
              ))}
            {jobs
              .filter((job) => job.roomId === room.id)
              .map((job) => (
                <View key={job.key} style={{ padding: 14, gap: 4, backgroundColor: c.surface1 }}>
                  <Text style={cell}>
                    {job.title} ·{" "}
                    {job.state === "exited"
                      ? "Process exited · result unverified"
                      : job.state === "running"
                        ? "Process running"
                        : "Process state unknown"}
                  </Text>
                  <Text
                    selectable
                    style={{
                      ...muted,
                      color: job.ownerStatus === "needs-owner" ? c.statusWarning : c.foregroundMuted,
                    }}
                  >
                    Owner: {job.ownerLabel}
                    {job.ownerStatus === "needs-owner" ? " · needs reassignment" : ""} · PID {job.pid}
                  </Text>
                </View>
              ))}
            {!compact && rows.length > 0 && (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderBottomWidth: 1,
                  borderColor: c.border,
                }}
              >
                <Text style={{ ...muted, flex: 1 }}>AGENT</Text>
                <Text style={{ ...muted, width: 84 }}>ROLE</Text>
                <Text style={{ ...muted, width: 144 }}>MODEL</Text>
                <Text style={{ ...muted, width: 105 }}>STATUS</Text>
                <Text style={{ ...muted, width: 58, textAlign: "right" }}>UPDATED</Text>
                <View style={{ width: 64 }} />
              </View>
            )}
            {rows.map((member) => {
              const state = activityState(member);
              const color = c[state.color];
              return (
                <View
                  key={member.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: compact ? 8 : 12,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    borderBottomWidth: 1,
                    borderColor: c.border,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <Text numberOfLines={1} style={cell}>
                      {member.title}
                    </Text>
                    {compact && (
                      <Text numberOfLines={1} style={muted}>
                        {member.role} · {member.model || member.provider.replace(/^alliance-/, "")}
                      </Text>
                    )}
                    <Text
                      numberOfLines={1}
                      style={{
                        ...muted,
                        color: member.ownerStatus === "needs-owner" ? c.statusWarning : c.foregroundMuted,
                      }}
                    >
                      Owner: {member.ownerLabel}
                      {member.ownerRevision ? " · assigned" : " · native parent"}
                      {member.ownerStatus === "needs-owner" ? " · unavailable" : ""}
                    </Text>
                    <Text style={muted}>
                      {acceptanceLabel({
                        ...member,
                        kind: member.decision === "accepted" ? member.lastAcceptance?.kind : null,
                      })}
                    </Text>
                    <Text style={muted}>
                      Policy: {member.policyAcknowledged ? "read acknowledged" : "read pending"}
                    </Text>
                    {member.lastAcceptance?.product && (
                      <Text numberOfLines={2} style={muted}>
                        Last product acceptance: {member.lastAcceptance.product.outcome}
                      </Text>
                    )}
                    {member.lastAcceptance && (
                      <Text numberOfLines={2} style={muted}>
                        Last decision: {member.lastAcceptance.decision}{" "}
                        {member.lastAcceptance.kind || "scope unspecified"} ·{" "}
                        {member.lastAcceptance.target || member.lastAcceptance.candidate.slice(0, 12)} ·{" "}
                        {relativeTime(member.lastAcceptance.at, now)} ago
                      </Text>
                    )}
                    {member.error && (
                      <Text numberOfLines={2} style={{ color: c.statusDanger, fontSize: 11 }}>
                        {member.error}
                      </Text>
                    )}
                    {member.silence && (
                      <Text numberOfLines={1} style={{ color: c.statusWarning, fontSize: 11 }}>
                        No activity for {relativeTime(member.silence.since, now)} in its running turn
                        {member.silence.key ? " · owner notified" : ""}
                      </Text>
                    )}
                    {member.denied && (
                      <Text numberOfLines={1} style={muted}>
                        Alliance denied its {member.denied.tool} approval request{" "}
                        {relativeTime(member.denied.at, now)} ago
                      </Text>
                    )}
                  </View>
                  {!compact && (
                    <Text numberOfLines={1} style={{ ...muted, width: 84 }}>
                      {member.role}
                    </Text>
                  )}
                  {!compact && (
                    <Text numberOfLines={1} style={{ ...muted, width: 144 }}>
                      {member.model || member.provider.replace(/^alliance-/, "")}
                    </Text>
                  )}
                  <View
                    style={{ width: compact ? 80 : 105, flexDirection: "row", alignItems: "center", gap: 6 }}
                  >
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
                    <Text numberOfLines={1} style={{ color, fontSize: 11, flexShrink: 1 }}>
                      {state.label}
                    </Text>
                  </View>
                  {!compact && (
                    <Text style={{ ...muted, width: 58, textAlign: "right", fontVariant: ["tabular-nums"] }}>
                      {relativeTime(member.updatedAt, now)}
                    </Text>
                  )}
                  {navigation && (
                    <View style={{ width: 64 }}>
                      <Button
                        label="Open"
                        icon="ArrowUpRight"
                        colors={c}
                        onPress={() => navigation.openAgent({ agentId: member.id, serverId: host.id })}
                      />
                    </View>
                  )}
                </View>
              );
            })}
            {!rows.length && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }}>
                <Text style={{ ...muted, flex: 1 }}>No agents</Text>
                {navigation && (
                  <Button
                    label="Open project"
                    icon="ArrowUpRight"
                    colors={c}
                    onPress={() =>
                      navigation.openWorkspace({ workspaceId: room.workspaceId, serverId: host.id })
                    }
                  />
                )}
              </View>
            )}
          </View>
        ))}
      </ScrollView>
      {modelRoom && (
        <ModelSettings
          roomId={modelRoom.id}
          title={modelRoom.title}
          theme={theme}
          hostId={host.id}
          onClose={() => setModelRoom(null)}
        />
      )}
      {adding && (
        <ProjectPicker
          theme={theme}
          host={host}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setProject(id);
            setFilter("all");
            setSearch("");
            setAdding(false);
            void cache.invalidateQueries({ queryKey });
          }}
        />
      )}
    </View>
  );
}
