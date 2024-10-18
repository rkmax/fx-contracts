//SPDX-License-Identifier: MIT
pragma solidity >=0.8.11 <0.9.0;

interface IFeeTierModule {
    /**
     * @notice thrown when fee tier id is 0, as it is base tier it cant be discounted.
     */
    error InvalidFeeTierId();
    /**
     * @notice emits when discount for a fee tier changes
     * @param id id of the fee tier.
     * @param makerDiscount maker discount.
     * @param takerDiscount taker discount.
     */
    event FeeTierSet(uint256 id, uint256 makerDiscount, uint256 takerDiscount);

    /**
     * @notice sets discount for a fee tier
     * @param id id of the fee tier.
     * @param makerDiscount maker discount.
     * @param takerDiscount taker discount.
     */
    function setFeeTier(uint256 id, uint256 makerDiscount, uint256 takerDiscount) external;

    /**
     * @notice gets fee discount for a fee tier
     * @param  id of the market.
     * @return makerDiscount maker discount.
     * @return takerDiscount taker discount.
     */
    function getFeeTier(
        uint256 id
    ) external view returns (uint256 makerDiscount, uint256 takerDiscount);
}
