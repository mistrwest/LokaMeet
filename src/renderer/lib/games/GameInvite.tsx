import React from "react";
import { useTranslation } from "react-i18next";
import { getGameCatalogItem } from "./registry";
import type { IncomingGameInvite } from "./types";

export function GameInviteCard(props: {
  invite: IncomingGameInvite;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { t } = useTranslation();
  const game = getGameCatalogItem(props.invite.gameId);
  return (
    <div className="panel gameInviteCard">
      <div className="panelHeader">
        <div>{t("gameInviteTitle")}</div>
      </div>
      <div className="panelBody">
        <div className="gameInviteName">{props.invite.fromUserName}</div>
        <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
          {t("gameInviteBody", { game: game ? t(game.titleKey) : props.invite.gameId })}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn btnPrimary grow" onClick={props.onAccept}>
            {t("accept")}
          </button>
          <button className="btn btnDanger grow" onClick={props.onDecline}>
            {t("reject")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GameInviteChatActions(props: {
  status: "pending" | "accepted" | "declined" | "cancelled";
  incoming: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  if (props.status === "accepted") {
    return <div className="muted gameInviteChatStatus">{t("gameInviteAcceptedChat")}</div>;
  }
  if (props.status === "declined") {
    return <div className="muted gameInviteChatStatus">{t("gameInviteDeclinedChat")}</div>;
  }
  if (props.status === "cancelled") {
    return <div className="muted gameInviteChatStatus">{t("gameInviteCancelledChat")}</div>;
  }
  return (
    <div className="gameInviteChatActions">
      {props.incoming ? (
        <>
          <button type="button" className="btn btnPrimary" onClick={props.onAccept}>
            {t("accept")}
          </button>
          <button type="button" className="btn btnDanger" onClick={props.onDecline}>
            {t("reject")}
          </button>
        </>
      ) : (
        <button type="button" className="btn" onClick={props.onCancel}>
          {t("cancel")}
        </button>
      )}
    </div>
  );
}
