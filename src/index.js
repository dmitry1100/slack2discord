const slackBackupReader = require('./slackBackupReader.js');
const discordApi = require('./discordApi.js');
const axios = require('axios');
const utils = require('./utils.js');
const { 
  guildId, 
  mapChannels = {}
} = require('../config.json');

const IMPORT_WEBHOOK_NAME = 'slack2discord';


const app = async () => {

  const slackChannelNames = await slackBackupReader.getChannelNames();

  const discordChannels = await discordApi.getOrCreateChannels({ channelNames: slackChannelNames, guildId });
  const discordChannelIds = discordChannels.map(ch => ch.id);
  
  const discordWebhooks = await discordApi.getOrCreateWebhooks({ channelIds: discordChannelIds, webhookName: IMPORT_WEBHOOK_NAME });
  const discordWebhooksByChannelId = discordWebhooks.reduce((acc, wh) => ({ ...acc, [wh.channel_id]: wh }), {});
  
  const files = await slackBackupReader.getMessagesFiles({ channelNames: slackChannelNames }); 
  const usersById = await slackBackupReader.getUsersById();
  const discordChannelByName = discordChannels.reduce((acc, ch) => ({ ...acc, [ch.name.toLowerCase()]: ch }), {});

  for (const file of files) {
    const msgs = (await slackBackupReader.getMessages(file.path))

    const formattedMsgs = msgs
      .map(msg => replaceMentions(msg, usersById))
      .map(msg => addUsername(msg, usersById))
      .map(addDateTime)
      .map(splitLongMessage)
      .reduce(utils.concat, []);

    
    
    const attachments = await Promise.all(
      msgs
        .filter(msg => msg.files)
        .map(getAttachments)
    );
    const attachmentByMessageId = utils.groupBy(attachments.reduce(utils.concat, []), 'messageId');

    const fileChannel = file.channel;
    const targetChannel = mapChannels[fileChannel] || fileChannel;
    const channel = discordChannelByName[targetChannel.toLowerCase()];
    const webhook = discordWebhooksByChannelId[channel.id];

    let i = 0;
    while(i < formattedMsgs.length) {
      
      const msg = formattedMsgs[i];

      try {
        const resp = await discordApi.sendMessage({ data: msg, webhook });
        if (resp.headers['x-ratelimit-remaining'] == 0) {
          await utils.delay(2000);
        }
        ++i;
      } catch (err) {
        if (err.response.status == 429) {
          const retryAfter = err.response.headers['retry-after']
          if (retryAfter) {
            console.log(`Retry after: ${retryAfter}ms`);
            await utils.delay(retryAfter);
          }
        } else {
          console.error(`Error sending message ${i} at ${file.path} to ${targetChannel}: ${err.response.data.text || err.response.status}`);
          ++i;
        }
      }

      try {
        const msgAttachments = attachmentByMessageId[msg.client_msg_id];
        if (msgAttachments) {
          await Promise.all(
            msgAttachments
              .map(att => ({
                username: msg.username,
                file: att.file,
                name: att.name
              }))
              .map(data => discordApi.sendAttachment({ data, webhook }))
          );
          attachmentByMessageId[msg.client_msg_id] = null;
        }
      } catch (err) {
        console.error(err);
      }
    }
  }
}

const getAttachments = async message => {
  const attachments = message.files.map(file => 
    axios({
      method: 'get',
      url: file.url_private_download.replace(/\\\//g, '/'), 
      responseType: 'arraybuffer'
    })
    .then(resp => ({
      messageId: message.client_msg_id,
      file: resp.data,
      name: file.name
    }))
    .catch(console.error)
  )
  return Promise.all(attachments);
}

const splitLongMessage = (message) => {
  const maxLength = 2000;
  if (message.text.length > maxLength) {
    const textChunks = message.text.match(new RegExp('.{1,' + maxLength + '}', 'g'));
    return textChunks.map(tc => ({
      ...message,
      text: tc
    }));
  }

  return [message];
}

const addDateTime = (message) => {
  const dateStr = utils.dateFormat(new Date(message.ts*1000));
  message.text = '`' + dateStr + '` ' + message.text;
  return message;
}

const addUsername = (message, usersById) => {
  message.username = findUsername(usersById, message.user);
  return message;
}

const replaceMentions = (message, usersById) => {
  message.text = message.text.replace(/<@\w+>/g, match => findUsername(usersById, match.substring(2, match.length - 1)));
  return message;
}

const findUsername = (usersById, userId) => {
  const user = usersById[userId];
  if (!user) {
    console.error(`User not found: ${userId}`);
    return userId;
  }
  return user.profile.display_name_normalized || user.profile.real_name_normalized || user.name || userId
}

app();