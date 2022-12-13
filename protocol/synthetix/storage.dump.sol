// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

// @custom:artifact @synthetixio/core-contracts/contracts/ownership/AuthorizableStorage.sol:AuthorizableStorage
library AuthorizableStorage {
    struct Data {
        address authorized;
    }
    function load() internal pure returns (Data storage store) {
        bytes32 s = keccak256(abi.encode("Authorizable"));
        assembly {
            store.slot := s
        }
    }
}

// @custom:artifact @synthetixio/core-contracts/contracts/ownership/OwnableStorage.sol:OwnableStorage
library OwnableStorage {
    struct Data {
        bool initialized;
        address owner;
        address nominatedOwner;
    }
    function load() internal pure returns (Data storage store) {
        bytes32 s = keccak256(abi.encode("Ownable"));
        assembly {
            store.slot := s
        }
    }
}

// @custom:artifact @synthetixio/core-contracts/contracts/proxy/ProxyStorage.sol:ProxyStorage
contract ProxyStorage {
    struct ProxyStore {
        address implementation;
        bool simulatingUpgrade;
    }
    function _proxyStore() internal pure returns (ProxyStore storage store) {
        assembly {
            store.slot := 0x32402780481dd8149e50baad867f01da72e2f7d02639a6fe378dbd80b6bb446e
        }
    }
}

// @custom:artifact @synthetixio/core-contracts/contracts/token/ERC20Storage.sol:ERC20Storage
library ERC20Storage {
    struct Data {
        string name;
        string symbol;
        uint8 decimals;
        mapping(address => uint256) balanceOf;
        mapping(address => mapping(address => uint256)) allowance;
        uint256 totalSupply;
    }
    function load() internal pure returns (Data storage store) {
        bytes32 s = keccak256(abi.encode("ERC20"));
        assembly {
            store.slot := s
        }
    }
}

// @custom:artifact @synthetixio/core-contracts/contracts/token/ERC721EnumerableStorage.sol:ERC721EnumerableStorage
library ERC721EnumerableStorage {
    struct Data {
        mapping(uint256 => uint256) ownedTokensIndex;
        mapping(uint256 => uint256) allTokensIndex;
        mapping(address => mapping(uint256 => uint256)) ownedTokens;
        uint256[] allTokens;
    }
    function load() internal pure returns (Data storage store) {
        bytes32 s = keccak256(abi.encode("ERC721Enumerable"));
        assembly {
            store.slot := s
        }
    }
}

// @custom:artifact @synthetixio/core-contracts/contracts/token/ERC721Storage.sol:ERC721Storage
library ERC721Storage {
    struct Data {
        string name;
        string symbol;
        string baseTokenURI;
        mapping(uint256 => address) ownerOf;
        mapping(address => uint256) balanceOf;
        mapping(uint256 => address) tokenApprovals;
        mapping(address => mapping(address => bool)) operatorApprovals;
    }
    function load() internal pure returns (Data storage store) {
        bytes32 s = keccak256(abi.encode("ERC721"));
        assembly {
            store.slot := s
        }
    }
}

// @custom:artifact @synthetixio/core-contracts/contracts/utils/HeapUtil.sol:HeapUtil
library HeapUtil {
    struct Data {
        uint128 idCount;
        Node[] nodes;
        mapping(uint128 => uint) indices;
    }
    struct Node {
        uint128 id;
        int128 priority;
    }
}

// @custom:artifact @synthetixio/core-contracts/contracts/utils/SetUtil.sol:SetUtil
library SetUtil {
    struct UintSet {
        Bytes32Set raw;
    }
    struct AddressSet {
        Bytes32Set raw;
    }
    struct Bytes32Set {
        bytes32[] _values;
        mapping(bytes32 => uint) _positions;
    }
}

// @custom:artifact @synthetixio/core-modules/contracts/storage/AssociatedSystem.sol:AssociatedSystem
library AssociatedSystem {
    struct Data {
        address proxy;
        address impl;
        bytes32 kind;
    }
    function load(bytes32 id) internal pure returns (Data storage store) {
        bytes32 s = keccak256(abi.encode("AssociatedSystem", id));
        assembly {
            store.slot := s
        }
    }
}

// @custom:artifact @synthetixio/core-modules/contracts/storage/FeatureFlag.sol:FeatureFlag
library FeatureFlag {
    struct Data {
        bytes32 name;
        bool allowAll;
        SetUtil.AddressSet permissionedAddresses;
    }
    function load(bytes32 featureName) internal pure returns (Data storage store) {
        bytes32 s = keccak256(abi.encode("FeatureFlag", featureName));
        assembly {
            store.slot := s
        }
    }
}

// @custom:artifact @synthetixio/core-modules/contracts/storage/Initialized.sol:Initialized
library Initialized {
    struct Data {
        bool initialized;
    }
    function load(bytes32 id) internal pure returns (Data storage store) {
        bytes32 s = keccak256(abi.encode("Initialized", id));
        assembly {
            store.slot := s
        }
    }
}

// @custom:artifact @synthetixio/oracle-manager/contracts/storage/Node.sol:Node
library Node {
    struct Data {
        int256 price;
        uint timestamp;
        uint volatilityScore;
        uint liquidityScore;
    }
}

// @custom:artifact @synthetixio/oracle-manager/contracts/storage/NodeDefinition.sol:NodeDefinition
library NodeDefinition {
    enum NodeType {
        NONE,
        REDUCER,
        EXTERNAL,
        CHAINLINK,
        PYTH
    }
    struct Data {
        bytes32[] parents;
        NodeType nodeType;
        bytes parameters;
    }
    function load(bytes32 id) internal pure returns (Data storage data) {
        bytes32 s = keccak256(abi.encode("Node", id));
        assembly {
            data.slot := s
        }
    }
}

// @custom:artifact contracts/interfaces/IAccountModule.sol:IAccountModule
interface IAccountModule {
    struct AccountPermissions {
        address user;
        bytes32[] permissions;
    }
}

// @custom:artifact contracts/interfaces/ILiquidationModule.sol:ILiquidationModule
interface ILiquidationModule {
    struct LiquidationData {
        uint256 debtLiquidated;
        uint256 collateralLiquidated;
        uint256 amountRewarded;
    }
}

// @custom:artifact contracts/interfaces/external/IEVM2AnySubscriptionOnRampRouterInterface.sol:IEVM2AnySubscriptionOnRampRouterInterface
interface IEVM2AnySubscriptionOnRampRouterInterface {
    struct EVM2AnySubscriptionMessage {
        bytes receiver;
        bytes data;
        address[] tokens;
        uint256[] amounts;
        uint256 gasLimit;
    }
}

// @custom:artifact contracts/storage/Account.sol:Account
library Account {
    struct Data {
        uint128 id;
        AccountRBAC.Data rbac;
        bytes32 __slotAvailableForFutureUse;
        mapping(address => Collateral.Data) collaterals;
    }
    function load(uint128 id) internal pure returns (Data storage data) {
        bytes32 s = keccak256(abi.encode("Account", id));
        assembly {
            data.slot := s
        }
    }
}

// @custom:artifact contracts/storage/AccountRBAC.sol:AccountRBAC
library AccountRBAC {
    struct Data {
        address owner;
        mapping(address => SetUtil.Bytes32Set) permissions;
        SetUtil.AddressSet permissionAddresses;
    }
}

// @custom:artifact contracts/storage/Collateral.sol:Collateral
library Collateral {
    struct Data {
        bool isSet;
        uint256 availableAmountD18;
        SetUtil.UintSet pools;
        CollateralLock.Data[] locks;
    }
}

// @custom:artifact contracts/storage/CollateralConfiguration.sol:CollateralConfiguration
library CollateralConfiguration {
    struct Data {
        bool depositingEnabled;
        uint256 issuanceRatioD18;
        uint256 liquidationRatioD18;
        uint256 liquidationRewardD18;
        bytes32 oracleNodeId;
        address tokenAddress;
        uint256 minDelegationD18;
    }
    function load(address token) internal pure returns (Data storage data) {
        bytes32 s = keccak256(abi.encode("CollateralConfiguration", token));
        assembly {
            data.slot := s
        }
    }
    function loadAvailableCollaterals() internal pure returns (SetUtil.AddressSet storage data) {
        bytes32 s = keccak256(abi.encode("CollateralConfiguration_availableCollaterals"));
        assembly {
            data.slot := s
        }
    }
}

// @custom:artifact contracts/storage/CollateralLock.sol:CollateralLock
library CollateralLock {
    struct Data {
        uint256 amountD18;
        uint64 lockExpirationTime;
    }
}

// @custom:artifact contracts/storage/Distribution.sol:Distribution
library Distribution {
    struct Data {
        uint128 totalSharesD18;
        int128 valuePerShareD27;
        mapping(bytes32 => DistributionActor.Data) actorInfo;
    }
}

// @custom:artifact contracts/storage/DistributionActor.sol:DistributionActor
library DistributionActor {
    struct Data {
        uint128 sharesD18;
        int128 lastValuePerShareD27;
    }
}

// @custom:artifact contracts/storage/Market.sol:Market
library Market {
    struct Data {
        uint128 id;
        address marketAddress;
        int128 netIssuanceD18;
        uint128 creditCapacityD18;
        int128 lastDistributedMarketBalanceD18;
        HeapUtil.Data inRangePools;
        HeapUtil.Data outRangePools;
        Distribution.Data poolsDebtDistribution;
        mapping(uint128 => MarketPoolInfo.Data) pools;
        DepositedCollateral[] depositedCollateral;
        mapping(address => uint256) maximumDepositableD18;
    }
    struct DepositedCollateral {
        address collateralType;
        uint256 amountD18;
    }
    function load(uint128 id) internal pure returns (Data storage data) {
        bytes32 s = keccak256(abi.encode("Market", id));
        assembly {
            data.slot := s
        }
    }
}

// @custom:artifact contracts/storage/MarketConfiguration.sol:MarketConfiguration
library MarketConfiguration {
    struct Data {
        uint128 marketId;
        uint128 weightD18;
        int128 maxDebtShareValueD18;
    }
}

// @custom:artifact contracts/storage/MarketCreator.sol:MarketCreator
library MarketCreator {
    struct Data {
        mapping(address => uint128[]) marketIdsForAddress;
        uint128 lastCreatedMarketId;
    }
    function getMarketStore() internal pure returns (Data storage data) {
        bytes32 s = keccak256("MarketStore");
        assembly {
            data.slot := s
        }
    }
}

// @custom:artifact contracts/storage/MarketPoolInfo.sol:MarketPoolInfo
library MarketPoolInfo {
    struct Data {
        uint128 creditCapacityAmountD18;
        uint128 pendingDebtD18;
    }
}

// @custom:artifact contracts/storage/OracleManager.sol:OracleManager
library OracleManager {
    struct Data {
        address oracleManagerAddress;
    }
    function load() internal pure returns (Data storage data) {
        bytes32 s = keccak256(abi.encode("OracleManager"));
        assembly {
            data.slot := s
        }
    }
}

// @custom:artifact contracts/storage/Pool.sol:Pool
library Pool {
    struct Data {
        uint128 id;
        string name;
        address owner;
        address nominatedOwner;
        uint128 totalWeightsD18;
        int128 totalVaultDebtsD18;
        MarketConfiguration.Data[] marketConfigurations;
        Distribution.Data vaultsDebtDistribution;
        mapping(address => Vault.Data) vaults;
    }
    function load(uint128 id) internal pure returns (Data storage data) {
        bytes32 s = keccak256(abi.encode("Pool", id));
        assembly {
            data.slot := s
        }
    }
}

// @custom:artifact contracts/storage/RewardDistribution.sol:RewardDistribution
library RewardDistribution {
    struct Data {
        address distributor;
        RewardDistributionEntry.Data entry;
        uint128 rewardPerShareD18;
        mapping(uint256 => RewardDistributionStatus.Data) actorInfo;
    }
}

// @custom:artifact contracts/storage/RewardDistributionEntry.sol:RewardDistributionEntry
library RewardDistributionEntry {
    struct Data {
        int128 scheduledValueD18;
        uint64 start;
        uint32 duration;
        uint32 lastUpdate;
    }
}

// @custom:artifact contracts/storage/RewardDistributionStatus.sol:RewardDistributionStatus
library RewardDistributionStatus {
    struct Data {
        uint128 lastRewardPerShareD18;
        uint128 pendingSendD18;
    }
}

// @custom:artifact contracts/storage/ScalableMapping.sol:ScalableMapping
library ScalableMapping {
    struct Data {
        uint128 totalSharesD18;
        int128 scaleModifierD27;
        mapping(bytes32 => uint256) sharesD18;
    }
}

// @custom:artifact contracts/storage/SystemPoolConfiguration.sol:SystemPoolConfiguration
library SystemPoolConfiguration {
    struct Data {
        uint minLiquidityRatioD18;
        uint preferredPool;
        SetUtil.UintSet approvedPools;
    }
    function load() internal pure returns (Data storage data) {
        bytes32 s = keccak256(abi.encode("PoolConfiguration"));
        assembly {
            data.slot := s
        }
    }
}

// @custom:artifact contracts/storage/Vault.sol:Vault
library Vault {
    struct Data {
        uint256 epoch;
        bytes32 __slotAvailableForFutureUse;
        int128 prevTotalDebtD18;
        mapping(uint256 => VaultEpoch.Data) epochData;
        mapping(bytes32 => RewardDistribution.Data) rewards;
        SetUtil.Bytes32Set rewardIds;
    }
}

// @custom:artifact contracts/storage/VaultEpoch.sol:VaultEpoch
library VaultEpoch {
    struct Data {
        int128 unconsolidatedDebtD18;
        int128 totalConsolidatedDebtD18;
        Distribution.Data accountsDebtDistribution;
        ScalableMapping.Data collateralAmounts;
        mapping(uint256 => int256) consolidatedDebtAmountsD18;
    }
}