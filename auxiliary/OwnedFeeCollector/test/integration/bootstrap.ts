import { coreBootstrap } from '@synthetixio/core-utils/utils/bootstrap/tests';
import { wei } from '@synthetixio/wei';
import { ethers } from 'ethers';

import { OwnedFeeCollector } from '../generated/typechain';

interface Contracts {
  owned_fee_collector: OwnedFeeCollector;
  'pyth.Pyth': ethers.Contract;
  'usd.MintableToken': ethers.Contract;
}

const ownerAddress = '0x48914229deDd5A9922f44441ffCCfC2Cb7856Ee9';

const params = { cannonfile: 'cannonfile.test.toml' };

const r = coreBootstrap<Contracts>(params);

const restoreSnapshot = r.createSnapshot();

export function bootstrap() {
  before(restoreSnapshot);
  return r;
}

async function getImpersonatedSigner(
  provider: ethers.providers.JsonRpcProvider,
  addr: string
): Promise<ethers.Signer> {
  await provider.send('hardhat_impersonateAccount', [addr]);

  return provider.getSigner(addr);
}

export function bootstrapOwnedFeeCollector() {
  const r = bootstrap();

  let user: ethers.Signer;
  let owner: ethers.Signer;

  before('get owner', async function () {
    [user] = r.getSigners();
    await user.sendTransaction({
      to: ownerAddress,
      value: bn(1),
    });
    owner = await getImpersonatedSigner(r.getProvider(), ownerAddress);
  });

  return {
    ...r,
    owner: () => owner,
    user: () => user,
  };
}

export const bn = (n: number) => wei(n).toBN();