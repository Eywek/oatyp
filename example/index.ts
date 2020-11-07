// tslint:disable: no-console

import Api from './api'

const api = new Api({
  baseURL: 'https://api.reelevant.com/v2'
})
api.Company.getCompanyDefaults({}, {
  headers: {
    Cookie: 'access_token=eyJhbGciOi...'
  }
})
  .then((r) => console.log(r.data.data.roleId))
  .catch(err => {
    console.error(err.response)
    process.exit(1)
  })
