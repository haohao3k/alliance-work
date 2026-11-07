import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { directoryList, roomCreate, roomList } from "../shared/contracts";
import { activityState, relativeTime } from "../shared/monitor";
import { acceptanceLabel } from "../shared/operations";
import { ClaudeAccountSettings } from "./claude-accounts";
import { McpSettings } from "./mcp-settings";
import { ModelSettings } from "./model-settings";
import { SkillSettings } from "./skill-settings";

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
  primary,
}: {
  label: string;
  icon?: string;
  onPress: () => void;
  colors: Colors;
  disabled?: boolean;
  selected?: boolean;
  primary?: boolean;
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
        minHeight: 40,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: selected || primary ? c.accent : c.border,
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
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectSettings, setProjectSettings] = useState<(typeof rooms)[number] | null>(null);
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(new Set());
  const [expandedObligations, setExpandedObligations] = useState<Set<string>>(new Set());
  const [expandedRooms, setExpandedRooms] = useState<Set<string>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [mcpRoom, setMcpRoom] = useState<{ cwd: string; title: string } | null>(null);
  const [skillsRoom, setSkillsRoom] = useState<{ cwd: string; title: string } | null>(null);
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
  const needsAttention = (member: (typeof members)[number]) =>
    Boolean(
      activityState(member).group === "attention" ||
        member.ownerStatus === "needs-owner" ||
        member.error ||
        member.silence ||
        member.denied ||
        (member.selectedModel && member.runtimeModel && member.selectedModel !== member.runtimeModel),
    );
  const counts = {
    all: members.length,
    working: members.filter((member) => activityState(member).group === "working").length,
    attention: members.filter(needsAttention).length,
    idle: members.filter((member) => activityState(member).group === "idle").length,
  };
  const openObligations = (data.data?.obligations ?? []).filter((item) => item.state === "open");
  const hasResponsibility = (roomId: string) =>
    openObligations.some((item) => item.roomId === roomId) ||
    jobs.some((item) => item.roomId === roomId) ||
    wakeups.some(
      (item) => item.roomId === roomId && !["acknowledged", "canceled", "expired"].includes(item.state),
    );
  const needle = search.trim().toLowerCase();
  const groups = rooms
    .filter((room) => !project || project === room.id)
    .map((room) => ({
      room,
      members: members
        .filter(
          (member) =>
            member.roomId === room.id &&
            (filter === "all" ||
              (filter === "attention" ? needsAttention(member) : activityState(member).group === filter)) &&
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
        (hasResponsibility(room.id) &&
          (!needle || `${room.title} ${room.cwd}`.toLowerCase().includes(needle))) ||
        (filter === "all" && (!needle || `${room.title} ${room.cwd}`.toLowerCase().includes(needle))),
    );
  const visibleRoomIds = new Set(groups.map(({ room }) => room.id));
  const hiddenObligations = openObligations.filter((item) => !visibleRoomIds.has(item.roomId)).length;
  const muted = { color: c.foregroundMuted, fontSize: 12, lineHeight: 18 };
  const cell = { color: c.foreground, fontSize: 13, lineHeight: 20 };
  const compact = layout.compact || panelWidth < 780;

  return (
    <View
      onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, backgroundColor: c.surface0 }}
    >
      <ScrollView
        contentContainerStyle={{
          padding: compact ? 14 : 24,
          gap: 20,
          width: "100%",
          maxWidth: 1200,
          alignSelf: "center",
        }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, minWidth: 180, gap: 5 }}>
            <Text style={{ color: c.foreground, fontSize: 26, fontWeight: "600" }}>Your projects</Text>
            <Text style={muted}>Alliance Work · {host.label}</Text>
          </View>
          <Button label="Add project" icon="Plus" primary colors={c} onPress={() => setAdding(true)} />
          <Button label="Settings" icon="Settings2" colors={c} onPress={() => setSettingsOpen(true)} />
        </View>
        {data.data?.wakeupHealth.error && (
          <Text accessibilityRole="alert" style={{ ...muted, color: c.statusWarning }}>
            {data.data.wakeupHealth.error}
          </Text>
        )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {(
            [
              ["all", "All sessions"],
              ["attention", "Session attention"],
              ["working", "Working"],
              ["idle", "Idle"],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              label={`${label} ${data.data ? counts[key] : "—"}`}
              icon={key === "attention" && counts[key] ? "CircleAlert" : undefined}
              colors={c}
              selected={filter === key}
              onPress={() => setFilter(key)}
            />
          ))}
          <View style={{ flex: 1 }} />
          <Text style={muted}>
            {rooms.length} projects · {openObligations.length} open obligations
          </Text>
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
              accessibilityLabel="Find a project or session"
              placeholder="Find a project or session…"
              placeholderTextColor={c.foregroundMuted}
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ flex: 1, minWidth: 0, minHeight: 36, color: c.foreground, fontSize: 12 }}
            />
          </View>
          <Button
            label="Refresh"
            icon="RefreshCw"
            colors={c}
            onPress={() => void data.refetch()}
            disabled={data.isFetching}
          />
        </View>
        {((project && !hiddenObligations) || archived) && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            {project && !hiddenObligations && (
              <Button
                label="Show all projects"
                icon="ArrowLeft"
                colors={c}
                onPress={() => setProject(null)}
              />
            )}
            {archived && (
              <Button
                label="Including archived · hide"
                colors={c}
                selected
                onPress={() => setArchived(false)}
              />
            )}
          </View>
        )}
        {hiddenObligations > 0 && (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 10,
              padding: 12,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 10,
            }}
          >
            <Icon name="CircleAlert" size={16} color={c.statusWarning} />
            <Text style={{ ...muted, flex: 1, minWidth: 180 }}>
              {hiddenObligations} open {hiddenObligations === 1 ? "obligation is" : "obligations are"} outside
              this view.
            </Text>
            <Button
              label="Show all projects"
              colors={c}
              onPress={() => {
                setProject(null);
                setSearch("");
                setFilter("all");
              }}
            />
          </View>
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
            <Text style={cell}>A home for your project work</Text>
            <Text style={muted}>Add a project to get started, or start an Alliance profile in Paseo.</Text>
          </View>
        )}
        {!!rooms.length && !groups.length && (
          <Text style={muted}>No projects or sessions match these filters.</Text>
        )}
        {groups.map(({ room, members: rows }) => {
          const projectExpanded = expandedProjects.has(room.id);
          const roomJobs = jobs.filter((job) => job.roomId === room.id);
          const roomObligations = openObligations.filter((item) => item.roomId === room.id);
          const roomWakeups = wakeups.filter(
            (item) =>
              item.roomId === room.id && !["acknowledged", "canceled", "expired"].includes(item.state),
          );
          const attention = members.filter(
            (member) => member.roomId === room.id && needsAttention(member),
          ).length;
          const runningJobs = roomJobs.filter((job) => job.state === "running").length;
          const exitedJobs = roomJobs.filter((job) => job.state === "exited").length;
          const unknownJobs = roomJobs.filter((job) => job.state === "unknown").length;
          const unownedJobs = roomJobs.filter((job) => job.ownerStatus === "needs-owner").length;
          const unownedObligations = roomObligations.filter(
            (item) => item.ownerStatus === "needs-owner",
          ).length;
          const expanded =
            expandedRooms.has(room.id) || project === room.id || filter !== "all" || Boolean(needle);
          const visibleRows = expanded ? rows : rows.filter(needsAttention);
          const working = rows.filter((member) => activityState(member).group === "working").length;
          return (
            <View
              key={room.id}
              style={{ borderWidth: 1, borderColor: c.border, borderRadius: 14, overflow: "hidden" }}
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
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${projectExpanded ? "Collapse" : "Expand"} project ${room.title}`}
                  accessibilityState={{ expanded: projectExpanded }}
                  onPress={() =>
                    setExpandedProjects((current) => {
                      const next = new Set(current);
                      if (next.has(room.id)) next.delete(room.id);
                      else next.add(room.id);
                      return next;
                    })
                  }
                  style={{
                    flex: 1,
                    minWidth: 0,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingVertical: 4,
                  }}
                >
                  <Icon
                    name={projectExpanded ? "ChevronDown" : "ChevronRight"}
                    size={18}
                    color={c.foregroundMuted}
                  />
                  <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <Text numberOfLines={1} style={{ ...cell, fontSize: 16, fontWeight: "600" }}>
                      {room.title}
                    </Text>
                    <Text numberOfLines={1} ellipsizeMode="head" style={muted}>
                      {room.cwd}
                    </Text>
                  </View>
                </Pressable>
                <Button
                  label="Settings"
                  icon="Settings2"
                  colors={c}
                  onPress={() => setProjectSettings(room)}
                />
              </View>
              <View
                style={{
                  paddingHorizontal: 16,
                  paddingBottom: 12,
                  paddingTop: 8,
                  gap: 4,
                  backgroundColor: c.surface1,
                }}
              >
                <Text style={muted}>
                  {rows.length} sessions{working ? ` · ${working} working` : ""}
                  {` · ${roomJobs.length} jobs`}
                  {runningJobs ? ` · ${runningJobs} running` : ""}
                  {roomObligations.length ? ` · ${roomObligations.length} open obligations` : ""}
                  {roomWakeups.length ? ` · ${roomWakeups.length} pending wakeups` : ""}
                </Text>
                {(attention > 0 ||
                  exitedJobs > 0 ||
                  unknownJobs > 0 ||
                  unownedJobs > 0 ||
                  unownedObligations > 0) && (
                  <Text style={{ ...muted, color: c.statusWarning }}>
                    {[
                      attention ? `${attention} sessions need attention` : "",
                      exitedJobs ? `${exitedJobs} exited jobs · results unverified` : "",
                      unknownJobs ? `${unknownJobs} jobs with unknown state` : "",
                      unownedJobs ? `${unownedJobs} jobs need owner` : "",
                      unownedObligations ? `${unownedObligations} obligations need owner` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                )}
              </View>
              {projectExpanded && (
                <>
                  {openObligations
                    .filter((o) => o.roomId === room.id)
                    .map((o) => {
                      const detailKey = `${room.id}:${o.key}`;
                      const detailsOpen = expandedObligations.has(detailKey);
                      return (
                        <View
                          key={o.key}
                          style={{
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            gap: 5,
                            borderLeftWidth: 3,
                            borderLeftColor: c.statusWarning,
                            borderBottomWidth: 1,
                            borderBottomColor: c.border,
                          }}
                        >
                          <View
                            style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}
                          >
                            <Text style={{ ...muted, color: c.statusWarning }}>
                              {o.ownerStatus === "needs-owner"
                                ? "Needs owner"
                                : o.blockedOn.length
                                  ? "Waiting"
                                  : "Open obligation"}
                            </Text>
                            <Text selectable style={{ ...muted, flex: 1, minWidth: 100 }}>
                              Owner: {o.ownerLabel}
                            </Text>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`${detailsOpen ? "Hide" : "Show"} obligation details: ${o.key}`}
                              accessibilityState={{ expanded: detailsOpen }}
                              onPress={() =>
                                setExpandedObligations((current) => {
                                  const next = new Set(current);
                                  if (next.has(detailKey)) next.delete(detailKey);
                                  else next.add(detailKey);
                                  return next;
                                })
                              }
                              style={{ paddingVertical: 5, paddingHorizontal: 4 }}
                            >
                              <Text style={{ ...muted, color: c.accent }}>
                                {detailsOpen ? "Less detail ↑" : "Details ↓"}
                              </Text>
                            </Pressable>
                          </View>
                          <Text selectable style={cell}>
                            {o.nextAction}
                          </Text>
                          {detailsOpen && (
                            <View style={{ gap: 4, paddingTop: 4 }}>
                              <Text selectable style={muted}>
                                Obligation: {o.key} · revision {o.revision} · owner {o.ownerStatus}
                              </Text>
                              {o.blockedOn.map((reason) => (
                                <Text key={reason} selectable style={muted}>
                                  {reason}
                                </Text>
                              ))}
                            </View>
                          )}
                        </View>
                      );
                    })}
                  {wakeups
                    .filter(
                      (w) =>
                        w.roomId === room.id && !["acknowledged", "canceled", "expired"].includes(w.state),
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
                  {rows.length > 0 && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${expanded ? "Collapse" : "Show"} sessions for ${room.title}`}
                      accessibilityState={{ expanded }}
                      onPress={() => {
                        if (project === room.id) setProject(null);
                        setExpandedRooms((current) => {
                          const next = new Set(current);
                          if (expanded) next.delete(room.id);
                          else next.add(room.id);
                          return next;
                        });
                      }}
                      disabled={filter !== "all" || Boolean(needle)}
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        borderBottomWidth: visibleRows.length ? 1 : 0,
                        borderBottomColor: c.border,
                      }}
                    >
                      <Icon
                        name={expanded ? "ChevronDown" : "ChevronRight"}
                        size={14}
                        color={c.foregroundMuted}
                      />
                      <Text style={{ ...cell, flex: 1 }}>
                        {expanded
                          ? "Sessions"
                          : `${rows.length} sessions${working ? ` · ${working} working` : ""}`}
                      </Text>
                      {!expanded && (
                        <Text style={muted}>
                          {visibleRows.length ? `${visibleRows.length} need attention` : "Show sessions"}
                        </Text>
                      )}
                    </Pressable>
                  )}
                  {!compact && visibleRows.length > 0 && (
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
                  {visibleRows.map((member) => {
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
                              color:
                                member.ownerStatus === "needs-owner" ? c.statusWarning : c.foregroundMuted,
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
                          {(!member.policyAcknowledged || expandedMembers.has(member.id)) && (
                            <Text
                              style={{
                                ...muted,
                                color: member.policyAcknowledged ? c.foregroundMuted : c.statusWarning,
                              }}
                            >
                              Policy: {member.policyAcknowledged ? "read acknowledged" : "read pending"}
                            </Text>
                          )}
                          {expandedMembers.has(member.id) && member.lastAcceptance?.product && (
                            <Text numberOfLines={2} style={muted}>
                              Last product acceptance: {member.lastAcceptance.product.outcome}
                            </Text>
                          )}
                          {expandedMembers.has(member.id) && member.lastAcceptance && (
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
                          {member.selectedModel &&
                            member.runtimeModel &&
                            member.selectedModel !== member.runtimeModel && (
                              <Text style={muted}>
                                Selected {member.selectedModel}; last reported {member.runtimeModel}. Verify
                                the current model before continuing.
                              </Text>
                            )}
                          {(member.lastAcceptance || member.policyAcknowledged) && (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`${expandedMembers.has(member.id) ? "Hide" : "Show"} details for ${member.title}`}
                              accessibilityState={{ expanded: expandedMembers.has(member.id) }}
                              onPress={() =>
                                setExpandedMembers((current) => {
                                  const next = new Set(current);
                                  if (next.has(member.id)) next.delete(member.id);
                                  else next.add(member.id);
                                  return next;
                                })
                              }
                              style={{ alignSelf: "flex-start", paddingVertical: 6 }}
                            >
                              <Text style={{ ...muted, color: c.accent }}>
                                {expandedMembers.has(member.id) ? "Less detail ↑" : "Session details ↓"}
                              </Text>
                            </Pressable>
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
                          style={{
                            width: compact ? 80 : 105,
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
                          <Text numberOfLines={1} style={{ color, fontSize: 11, flexShrink: 1 }}>
                            {state.label}
                          </Text>
                        </View>
                        {!compact && (
                          <Text
                            style={{ ...muted, width: 58, textAlign: "right", fontVariant: ["tabular-nums"] }}
                          >
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
                      <Text style={{ ...muted, flex: 1 }}>
                        {(data.data?.members ?? []).some((member) => member.roomId === room.id)
                          ? "No sessions match these filters"
                          : "No sessions"}
                      </Text>
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
                </>
              )}
            </View>
          );
        })}
      </ScrollView>
      {settingsOpen && (
        <Modal
          title="Workspace settings"
          open
          onOpenChange={(open) => {
            if (!open) setSettingsOpen(false);
          }}
        >
          <Modal.Content contentContainerStyle={{ padding: 20, gap: 16 }}>
            <Text style={muted}>Connections and display preferences for {host.label}.</Text>
            <Button
              label="Claude accounts"
              icon="Settings2"
              colors={c}
              onPress={() => {
                setSettingsOpen(false);
                setAccountsOpen(true);
              }}
            />
            <Button
              label={archived ? "Hide archived sessions" : "Include archived sessions"}
              icon="Archive"
              colors={c}
              selected={archived}
              onPress={() => setArchived(!archived)}
            />
          </Modal.Content>
        </Modal>
      )}
      {projectSettings && (
        <Modal
          title={projectSettings.title}
          open
          onOpenChange={(open) => {
            if (!open) setProjectSettings(null);
          }}
        >
          <Modal.Content contentContainerStyle={{ padding: 20, gap: 14 }}>
            <Text selectable style={muted}>
              {projectSettings.cwd}
            </Text>
            <Text style={cell}>Project settings</Text>
            <Button
              label="Models"
              icon="Settings2"
              colors={c}
              onPress={() => {
                setModelRoom(projectSettings);
                setProjectSettings(null);
              }}
            />
            <Button
              label="Skills"
              icon="BookOpen"
              colors={c}
              onPress={() => {
                setSkillsRoom(projectSettings);
                setProjectSettings(null);
              }}
            />
            <Button
              label="MCP connections"
              icon="Settings2"
              colors={c}
              onPress={() => {
                setMcpRoom(projectSettings);
                setProjectSettings(null);
              }}
            />
            {navigation && (
              <Button
                label="Open project"
                icon="ArrowUpRight"
                colors={c}
                onPress={() => {
                  navigation.openWorkspace({ workspaceId: projectSettings.workspaceId, serverId: host.id });
                  setProjectSettings(null);
                }}
              />
            )}
          </Modal.Content>
        </Modal>
      )}
      {mcpRoom && (
        <McpSettings
          cwd={mcpRoom.cwd}
          title={mcpRoom.title}
          hostId={host.id}
          theme={theme}
          onClose={() => setMcpRoom(null)}
        />
      )}
      {accountsOpen && (
        <ClaudeAccountSettings host={host} theme={theme} onClose={() => setAccountsOpen(false)} />
      )}
      {skillsRoom && (
        <SkillSettings
          cwd={skillsRoom.cwd}
          title={skillsRoom.title}
          hostId={host.id}
          theme={theme}
          onClose={() => setSkillsRoom(null)}
        />
      )}
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
