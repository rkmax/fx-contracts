import { SourceUnit } from 'solidity-ast';
import { JsonFragment } from '@ethersproject/abi';

export interface DeploymentData {
  properties: {
    completed: boolean;
    totalGasUsed: string;
  };

  transactions: {
    [txhash: string]: {
      status: 'confirmed' | 'failed';
      block: number;
      description: string;
    };
  };

  contracts: {
    [contractFullyQualifiedName: string]: {
      deployedAddress: string;
      deployTransaction: string;
      deployedBytecodeHash: string;
      contractFullyQualifiedName: string;
      contractName: string;
      sourceName: string;
      deploymentBlock: number;
      deploymentCommit: string;
      proxyAddress?: string;
      isModule?: boolean;
      isProxy?: boolean;
      isRouter?: boolean;
    };
  };
}

export interface DeploymentSources {
  [sourceName: string]: {
    sourceCode: string;
    ast: SourceUnit;
  };
}

export interface DeploymentAbis {
  [contractFullyQualifiedName: string]: ReadonlyArray<JsonFragment>;
}