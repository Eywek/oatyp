// tslint:disable: no-console

import Api from './api'
import { User } from './definitions'

const api = new Api({
  baseURL: 'https://api.reelevant.com/v2'
})
api.User.create({}, {
  email: 'my email',
  password: 'my password',
  roleId: 'my role id',
  resourceGroupIds: ['group'],
  profile: undefined
}, {
  headers: {
    Cookie: 'access_token=eyJhbGciOi...'
  }
})
  .then((r) => console.log(r.data.data.password))
  .catch(err => {
    console.error(err.response)
    process.exit(1)
  })
