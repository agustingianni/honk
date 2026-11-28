# Changelog

## [0.3.0](https://github.com/agustingianni/honk/compare/v0.2.0...v0.3.0) (2026-11-28)


### Features

* add a setting to turn off mouse capture ([#78](https://github.com/agustingianni/honk/issues/78)) ([d9d31a0](https://github.com/agustingianni/honk/commit/d9d31a0c5d100e7ab614f6f1aed48286e86b7b0d))
* choose the timestamp format of chat lines ([#125](https://github.com/agustingianni/honk/issues/125)) ([f8882b9](https://github.com/agustingianni/honk/commit/f8882b9ed7d86d1ab80f0466de7eca4bf3642de9))
* click a nick in the chat to message them ([#13](https://github.com/agustingianni/honk/issues/13)) ([21437eb](https://github.com/agustingianni/honk/commit/21437ebbd8cce4b09f04ea2bfd1d070fbcd2dbf8))
* click nicks and channel names in messages to open a DM or join ([#71](https://github.com/agustingianni/honk/issues/71)) ([0c2b3d7](https://github.com/agustingianni/honk/commit/0c2b3d7622ba50edfdea882cb4703cd782de3753))
* draw plain ASCII instead of Unicode symbols with --ascii ([#81](https://github.com/agustingianni/honk/issues/81)) ([4ad35e4](https://github.com/agustingianni/honk/commit/4ad35e4a8eaae45bb8e70b70de167f8167025793))
* fit the nick column and the side panels to the names in use ([#118](https://github.com/agustingianni/honk/issues/118)) ([803b742](https://github.com/agustingianni/honk/commit/803b74297a51189eb6aaff7919737b08cfe558c2))
* highlight nicks, buffers, and omnibox rows under the mouse ([#11](https://github.com/agustingianni/honk/issues/11)) ([7d6ee11](https://github.com/agustingianni/honk/commit/7d6ee117f246551cd3ff9d1657e3cfabaf3d6a80))
* keep a log of your chats on disk ([#111](https://github.com/agustingianni/honk/issues/111)) ([6081d39](https://github.com/agustingianni/honk/commit/6081d398f84a6ca73aa9ae5ea654a53870f845a6))
* keep scrollback after a restart, and scroll back through your logs ([#127](https://github.com/agustingianni/honk/issues/127)) ([349defb](https://github.com/agustingianni/honk/commit/349defb5c5c77fa03263c9f35c2acaac1a2f0166))
* keep the joins, parts and other events you missed in the log ([#131](https://github.com/agustingianni/honk/issues/131)) ([178a7a9](https://github.com/agustingianni/honk/commit/178a7a923c1e23b0667c4eb5e3428ee50d4e6590))
* log the DMs sent to you while honk was closed ([807e829](https://github.com/agustingianni/honk/commit/807e8293190f3da12a970b14392fff7155cc55eb))
* open links in messages and the topic with a plain click ([deb9f03](https://github.com/agustingianni/honk/commit/deb9f03ac16b2b2342f0d32bb8723bfd9f248f39))
* search your chat logs with Ctrl+F ([#117](https://github.com/agustingianni/honk/issues/117)) ([130edeb](https://github.com/agustingianni/honk/commit/130edeb67467b53855a6c530de1e306edb005cf2))
* show a line with the date where the day changes in the chat ([#79](https://github.com/agustingianni/honk/issues/79)) ([7cda809](https://github.com/agustingianni/honk/commit/7cda809a76907d3567c6edc0a397c89101c506c1))
* show where you left off after a restart, synced with your other clients ([#40](https://github.com/agustingianni/honk/issues/40)) ([bb23743](https://github.com/agustingianni/honk/commit/bb23743bcb3f501aad24453b33c613729f4e3d54))


### Bug Fixes

* /history no longer skips lines of the second where the screen begins ([#195](https://github.com/agustingianni/honk/issues/195)) ([aa6e8ba](https://github.com/agustingianni/honk/commit/aa6e8baae83456e88fec04c2a1d8b70d40a33f07))
* a buffer you only flipped past keeps its unread badge, as on your other clients ([#107](https://github.com/agustingianni/honk/issues/107)) ([f64c2d6](https://github.com/agustingianni/honk/commit/f64c2d6de9f214b685e8ba97ab16329b2666fdca)), closes [#49](https://github.com/agustingianni/honk/issues/49)
* a colored topic is no longer cut too early ([deb9f03](https://github.com/agustingianni/honk/commit/deb9f03ac16b2b2342f0d32bb8723bfd9f248f39))
* a failed /history now shows its error in the buffer you typed it in ([#41](https://github.com/agustingianni/honk/issues/41)) ([3c7e4b4](https://github.com/agustingianni/honk/commit/3c7e4b4f0328fd8ac8fd30d92a8ad6445f23c428)), closes [#32](https://github.com/agustingianni/honk/issues/32)
* a failed history fetch shows its error in its own channel ([#45](https://github.com/agustingianni/honk/issues/45)) ([8f6a3a7](https://github.com/agustingianni/honk/commit/8f6a3a7632d0d47ae28b66c7b8a84e233c009e43))
* a focused honk on a locked screen no longer marks lines read while you are away ([9a3d3be](https://github.com/agustingianni/honk/commit/9a3d3be0a3ab62fa148d1ef02e63e3e945424087))
* a line you read on another client no longer counts as unread ([#99](https://github.com/agustingianni/honk/issues/99)) ([4ac8577](https://github.com/agustingianni/honk/commit/4ac8577dbf49bca88948c200d90dd8550fb599f1))
* a mention in the buffer on screen notifies you when you are away from the terminal ([9a3d3be](https://github.com/agustingianni/honk/commit/9a3d3be0a3ab62fa148d1ef02e63e3e945424087))
* a server clock far ahead no longer stops the log from catching up ([#135](https://github.com/agustingianni/honk/issues/135)) ([2cfa7b2](https://github.com/agustingianni/honk/commit/2cfa7b2fe8b41990ba9f45b8e4abeb3e9c15e11f))
* a server that never sends a newline no longer makes honk use more and more memory ([#64](https://github.com/agustingianni/honk/issues/64)) ([f72d922](https://github.com/agustingianni/honk/commit/f72d9225ec38d25f56345e5fede2a345da5591fb))
* after a reconnect, no longer skip lines sent in the same millisecond as the last one honk logged ([47bbf3a](https://github.com/agustingianni/honk/commit/47bbf3a78cee799b9c0a76160daee9eebad83423))
* after a reconnect, the log no longer misses lines that arrive at the same moment ([#168](https://github.com/agustingianni/honk/issues/168)) ([5e34340](https://github.com/agustingianni/honk/commit/5e34340b5e91438b0978aa00e9b32a77c9eedefe))
* an error in an event handler no longer stops reading from that server ([#63](https://github.com/agustingianni/honk/issues/63)) ([ceb3bb4](https://github.com/agustingianni/honk/commit/ceb3bb4ab021bb5602f477df02ba5992c4d31b80))
* an unlabeled history error in one channel no longer loses /history replies in another ([8f6a3a7](https://github.com/agustingianni/honk/commit/8f6a3a7632d0d47ae28b66c7b8a84e233c009e43))
* colored text is readable on selected and hovered rows in every theme ([#72](https://github.com/agustingianni/honk/issues/72)) ([ad1684c](https://github.com/agustingianni/honk/commit/ad1684c403bbee2010a5491df31246e57534f0a5))
* DMs open on screen get the lines missed during a reconnect ([807e829](https://github.com/agustingianni/honk/commit/807e8293190f3da12a970b14392fff7155cc55eb))
* honk logs again after a crash and a restart, when another process got its old pid ([#136](https://github.com/agustingianni/honk/issues/136)) ([feac38f](https://github.com/agustingianni/honk/commit/feac38f783393b178bf2ff785274b501aad31762))
* honk no longer quits on a server line it cannot handle ([#22](https://github.com/agustingianni/honk/issues/22)) ([d342863](https://github.com/agustingianni/honk/commit/d3428633397e93d7eebadb427e182d965890d3fe)), closes [#15](https://github.com/agustingianni/honk/issues/15)
* honk upgrade gives up when a download stops sending data ([#62](https://github.com/agustingianni/honk/issues/62)) ([7748e4d](https://github.com/agustingianni/honk/commit/7748e4d0d7b0ad8952e42d51ca315d9df8ee8dce)), closes [#14](https://github.com/agustingianni/honk/issues/14)
* honk upgrade no longer hangs while downloading the release ([#9](https://github.com/agustingianni/honk/issues/9)) ([3e3e571](https://github.com/agustingianni/honk/commit/3e3e571bd876ce80b4b64053e6bebe7718d69a9b))
* ignore .env and bunfig.toml in the folder where honk starts ([#199](https://github.com/agustingianni/honk/issues/199)) ([1a37c5e](https://github.com/agustingianni/honk/commit/1a37c5e6be6b1ed80942f9871b8f72b543ec5f73))
* keep log lines in memory while the file is locked or the disk is full ([#132](https://github.com/agustingianni/honk/issues/132)) ([9f8f27b](https://github.com/agustingianni/honk/commit/9f8f27bbccd5b2bb8c2040ed4dd2f31f774485f1))
* keep the "new messages" divider on one line ([#19](https://github.com/agustingianni/honk/issues/19)) ([71a47bf](https://github.com/agustingianni/honk/commit/71a47bf23e368cfc7c478e3aa4bcf7021d3d14cc))
* lines repeated within two seconds no longer vanish after a reconnect ([#104](https://github.com/agustingianni/honk/issues/104)) ([e915ca1](https://github.com/agustingianni/honk/commit/e915ca12ada972fdd6ed2336a7ba7566a6ee0fd0))
* links and notifications no longer carry hidden bidi characters ([#76](https://github.com/agustingianni/honk/issues/76)) ([d113c8b](https://github.com/agustingianni/honk/commit/d113c8b4cd26bb792356ec9ea021269c5268e429))
* load history and read markers when you log in without SASL ([#97](https://github.com/agustingianni/honk/issues/97)) ([1b8ef58](https://github.com/agustingianni/honk/commit/1b8ef5857a26a32e8bc627ab1972ed15cbf1f591)), closes [#47](https://github.com/agustingianni/honk/issues/47)
* load history on servers that reject an empty tag section ([#98](https://github.com/agustingianni/honk/issues/98)) ([f0d0828](https://github.com/agustingianni/honk/commit/f0d0828d32a2400985ef52e51fe99f033901399f))
* muted text is weaker than secondary text in every theme ([#116](https://github.com/agustingianni/honk/issues/116)) ([ac5d081](https://github.com/agustingianni/honk/commit/ac5d0814b28d8c414959d305aa4f47d6301cb18c))
* reading with only the mouse moves your read marker ([9a3d3be](https://github.com/agustingianni/honk/commit/9a3d3be0a3ab62fa148d1ef02e63e3e945424087))
* say which download failed, and why, when the connection breaks ([3e3e571](https://github.com/agustingianni/honk/commit/3e3e571bd876ce80b4b64053e6bebe7718d69a9b))
* show a failed save of your read position once in *status, not in the chat ([#89](https://github.com/agustingianni/honk/issues/89)) ([766f5ae](https://github.com/agustingianni/honk/commit/766f5ae5b41dff4625221cf9ea2b0d7207c21093)), closes [#60](https://github.com/agustingianni/honk/issues/60)
* show your own join once when you scroll to the top of a channel ([#196](https://github.com/agustingianni/honk/issues/196)) ([49c03d9](https://github.com/agustingianni/honk/commit/49c03d9252e19d203646f12762c129cd7939a098))
* stop memory from growing in a busy channel ([#197](https://github.com/agustingianni/honk/issues/197)) ([0cb4688](https://github.com/agustingianni/honk/commit/0cb468892fcede98c75dd7292c6dfd84ed2997f2))
* switching buffers right after you come back no longer marks the lines you missed as read ([#106](https://github.com/agustingianni/honk/issues/106)) ([3671559](https://github.com/agustingianni/honk/commit/3671559eae5f80af29f61121caf744eca4b30e93))
* the active channel row is easy to see in every theme ([#70](https://github.com/agustingianni/honk/issues/70)) ([6f58246](https://github.com/agustingianni/honk/commit/6f5824649140fd8b7d0f9a1d0f76df52b40a65c4))
* the selected omnibox row is easy to see in every theme ([#67](https://github.com/agustingianni/honk/issues/67)) ([69ffb4c](https://github.com/agustingianni/honk/commit/69ffb4c97512bab59f74fc7016f6adaf1d770551))
* treat channel and nick names the way the server compares them ([#105](https://github.com/agustingianni/honk/issues/105)) ([1687f70](https://github.com/agustingianni/honk/commit/1687f7084e1f9e3d791eaffd969f21f22b64f1fc))
* wide characters in nicks, channel names, and topics no longer break the layout ([#54](https://github.com/agustingianni/honk/issues/54)) ([d6399cb](https://github.com/agustingianni/honk/commit/d6399cb218708af67b218431668d07b1380b7209)), closes [#26](https://github.com/agustingianni/honk/issues/26)
* your own message no longer shows twice ([#53](https://github.com/agustingianni/honk/issues/53)) ([f0278c7](https://github.com/agustingianni/honk/commit/f0278c7dcb1aea409e089ddb0dd6d7a1b2a2d207))


### Performance Improvements

* remove old log lines without a pause of up to a second ([#139](https://github.com/agustingianni/honk/issues/139)) ([853f2cb](https://github.com/agustingianni/honk/commit/853f2cb53f0d3f5473160ac22d710f2766108ae0))
* search a large log without a pause at each key ([#137](https://github.com/agustingianni/honk/issues/137)) ([05e8952](https://github.com/agustingianni/honk/commit/05e895288c2da0217b5ab6172c27cd78634f067d))
* skip the extra history request for quiet channels after a reconnect ([47bbf3a](https://github.com/agustingianni/honk/commit/47bbf3a78cee799b9c0a76160daee9eebad83423))
* start about 30% faster ([#200](https://github.com/agustingianni/honk/issues/200)) ([24ee270](https://github.com/agustingianni/honk/commit/24ee270430072c4979a455bfb1dbd8fdac1cc7d1))

## [0.2.0](https://github.com/agustingianni/honk/compare/v0.1.0...v0.2.0) (2026-11-27)


### Features

* list one command per line in /help, with what it does ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* rank omnibox matches like fzf and highlight the matched letters ([1a0b610](https://github.com/agustingianni/honk/commit/1a0b6106395b4cb7d9c14f6119b586d6fc37f6b2))
* rank the omnibox actions you used last first ([1a0b610](https://github.com/agustingianni/honk/commit/1a0b6106395b4cb7d9c14f6119b586d6fc37f6b2))
* run omnibox actions on any server, not only the active one ([1a0b610](https://github.com/agustingianni/honk/commit/1a0b6106395b4cb7d9c14f6119b586d6fc37f6b2))
* say when /history finds no older messages ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* show desktop notifications inside tmux and zellij ([7f046ff](https://github.com/agustingianni/honk/commit/7f046ff3024c9771f72b41965ca0fb4237febe3c))
* show invites to a channel ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* show server replies and errors in plain words ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))


### Bug Fixes

* mark a message as not sent when the server refuses it ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* play back history without HistServ lines on Ergo servers ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* remove mIRC color codes from system lines such as the MOTD ([5c02c5b](https://github.com/agustingianni/honk/commit/5c02c5b3d1299104379d121a529bbc442b58ea58))
* say what is wrong with a broken config file, not show a stack trace ([d79d27c](https://github.com/agustingianni/honk/commit/d79d27c9e9ee777ee23c7c25e0e52615ac4f9873))
* show that someone is away once per DM, not on every message ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* try another nick when the network holds yours (437) ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
