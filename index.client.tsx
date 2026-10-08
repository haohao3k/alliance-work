import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Rooms } from "./client/rooms";

export default function contribute(client: PluginClientContext) {
  client.addSurface("rooms", Rooms);
  client.addSidebarItem({ id: "rooms", title: "Alliance Work", icon: "UsersRound", surface: "rooms" });
  client.addCommandCenterItem({
    id: "rooms",
    title: "Open Alliance Work",
    icon: "UsersRound",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("rooms");
    },
  });
  return () => {};
}
