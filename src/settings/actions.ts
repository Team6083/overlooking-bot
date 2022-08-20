const prefix = 'storage_settings';

export const actions = {
    showConversations: `${prefix}/show_conv`,
    showConversationsNextPage: `${prefix}/show_conv_next_page`,
    joinPublicChannels: `${prefix}/join_public_channels`,
    joinPublicChannelsAddAll: `${prefix}/join_public_channels_add_all`,
    joinPublicChannelsSelect: `${prefix}/join_public_channels_select`,
    joinPublicChannelsSubmit: `${prefix}/join_public_channels_submit`,
    goto: `${prefix}/goto`,
}

export const goto_dest = {
    menu: 'menu'
}
