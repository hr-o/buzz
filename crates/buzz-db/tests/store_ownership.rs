fn count(haystack: &str, needle: &str) -> usize {
    haystack.match_indices(needle).count()
}

#[test]
fn channel_and_membership_stores_have_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let channels = include_str!("../src/channel.rs");
    let members = include_str!("../src/channel_members.rs");

    for method in [
        "create_channel",
        "create_channel_with_id",
        "get_channel",
        "get_canvas",
        "set_canvas",
        "list_channels",
        "update_channel",
        "set_topic",
        "set_purpose",
        "archive_channel",
        "unarchive_channel",
        "soft_delete_channel",
        "reap_expired_ephemeral_channels",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(channels, &signature),
            2,
            "{method} must have one Db method and one SQL function in channel.rs"
        );
        assert_eq!(
            count(members, &signature),
            0,
            "{method} leaked into membership"
        );
        let span = format!("name = \"{method}\"");
        assert_eq!(count(channels, &span), 1, "{method} span is not unique");
    }

    for method in [
        "verify_channel_roster_fence",
        "lock_member_snapshot",
        "add_member",
        "remove_member",
        "is_member",
        "membership_pairs",
        "get_members",
        "get_members_bulk",
        "get_accessible_channel_ids",
        "list_large_channel_rosters_needing_reconciliation",
        "get_accessible_channels",
        "get_bot_members",
        "get_users_bulk",
        "get_member_count",
        "get_member_counts_bulk",
        "get_member_role",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        let expected = if method == "verify_channel_roster_fence" {
            1
        } else {
            2
        };
        assert_eq!(
            count(members, &signature),
            expected,
            "{method} must be singly owned by channel_members.rs"
        );
        let span = format!("name = \"{method}\"");
        assert_eq!(count(members, &span), 1, "{method} span is not unique");
    }

    for ty in [
        "MemberRecord",
        "LockedMemberSnapshot",
        "LargeChannelRoster",
        "AccessibleChannel",
        "BotChannelEntry",
        "BotMemberRecord",
        "UserRecord",
    ] {
        assert_eq!(count(root, &format!("struct {ty}")), 0);
        assert_eq!(
            count(members, &format!("struct {ty}")),
            1,
            "{ty} is not singly owned"
        );
    }

    for test_name in [
        "unmigrated_roster_fence_blocks_startup_until_0032_is_applied",
        "channel_roster_fence_behavior_verification_detects_inert_function",
        "channel_roster_fence_catalog_verification_fails_closed",
        "desired_schema_rejects_stale_legacy_roster_role",
    ] {
        assert_eq!(
            count(root, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in lib.rs"
        );
        assert_eq!(
            count(members, &format!("async fn {test_name}(")),
            1,
            "{test_name} is not singly owned"
        );
    }

    for ty in ["ChannelRecord", "ChannelUpdate", "ReapedEphemeralChannel"] {
        assert_eq!(
            count(channels, &format!("struct {ty}")),
            1,
            "{ty} is not singly owned"
        );
        assert_eq!(
            count(members, &format!("struct {ty}")),
            0,
            "{ty} leaked into membership"
        );
    }

    for test_name in [
        "get_channel_is_scoped_when_channel_uuid_collides_across_communities",
        "test_unarchive_expired_ephemeral_channel_renews_ttl_deadline",
        "reap_expired_ephemeral_channels_returns_row_community_and_host",
    ] {
        assert_eq!(
            count(root, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in lib.rs"
        );
        assert_eq!(
            count(channels, &format!("async fn {test_name}(")),
            1,
            "{test_name} is not singly owned"
        );
        assert_eq!(
            count(members, &format!("async fn {test_name}(")),
            0,
            "{test_name} leaked into membership"
        );
    }

    for test_name in [
        "get_users_bulk_is_scoped_when_pubkey_exists_in_multiple_communities",
        "test_agent_owner_can_remove_bot",
        "accessible_channel_ids_are_not_truncated_at_one_thousand",
        "get_members_returns_full_roster_beyond_1000",
        "large_roster_reconciliation_candidates_respect_snapshot_count_and_signer",
        "test_random_user_cannot_remove_bot",
        "repro_unprivileged_member_can_demote_owner",
        "repro_private_channel_member_can_demote_owner",
        "owner_can_still_manage_roles_after_demotion_guard",
        "unprivileged_member_cannot_demote_a_co_owner",
        "locked_member_snapshot_blocks_post_capture_membership_mutation",
        "membership_writes_serialize_on_the_shared_channel_lock",
        "remove_member_rejects_an_actor_demoted_while_it_waited",
        "kicked_owner_rejoins_as_member_not_owner",
        "removed_owner_is_restored_only_by_a_current_owner",
    ] {
        assert_eq!(
            count(root, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in lib.rs"
        );
        assert_eq!(
            count(channels, &format!("async fn {test_name}(")),
            0,
            "{test_name} remains in channel.rs"
        );
        assert_eq!(
            count(members, &format!("async fn {test_name}(")),
            1,
            "{test_name} is not singly owned"
        );
    }
}

#[test]
fn api_token_store_has_single_ownership() {
    let root = include_str!("../src/lib.rs");
    let store = include_str!("../src/api_token.rs");

    for method in [
        "create_api_token",
        "create_api_token_if_under_limit",
        "get_api_token_by_hash_including_revoked",
        "list_tokens_by_owner",
        "revoke_token",
        "revoke_all_tokens",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(
            count(store, &signature),
            2,
            "{method} lacks Db or SQL ownership"
        );
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    for method in [
        "get_api_token_by_hash",
        "touch_api_token",
        "list_active_tokens",
    ] {
        let signature = format!("pub async fn {method}(");
        assert_eq!(count(root, &signature), 0, "{method} remains in lib.rs");
        assert_eq!(count(store, &signature), 1, "{method} is not singly owned");
        assert_eq!(
            count(store, &format!("name = \"{method}\"")),
            1,
            "{method} span is not unique"
        );
    }

    assert_eq!(count(root, "pub async fn update_token_last_used("), 0);
    assert_eq!(count(store, "pub async fn update_token_last_used("), 1);
    assert_eq!(
        count(store, "name = \"update_token_last_used\""),
        0,
        "alias must reuse the touch span"
    );

    for ty in ["ApiTokenRecord", "TokenSummary"] {
        assert_eq!(
            count(root, &format!("struct {ty}")),
            0,
            "{ty} remains in lib.rs"
        );
        assert_eq!(
            count(store, &format!("struct {ty}")),
            1,
            "{ty} is not singly owned"
        );
    }
    assert_eq!(count(root, "fn parse_api_token_row("), 0);
    assert_eq!(count(store, "fn parse_api_token_row("), 1);
}
